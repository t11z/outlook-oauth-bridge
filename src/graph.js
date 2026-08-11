import { config } from './config.js';
import * as oauth from './oauth.js';

const GRAPH_TIMEOUT_MS = 120_000;

// Connection failures that prove the request never reached Graph at all —
// safe to retry up to the full attempt limit.
const CLEAN_TRANSPORT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);

// sendMail has no idempotency key and a 202 means "accepted", not
// "delivered". If the request times out or the connection resets AFTER it
// may have reached Graph, a retry can duplicate the message — there is no
// way to detect this. So these failures get a much lower retry cap
// (queue.js: AMBIGUOUS_MAX_ATTEMPTS) instead of the normal one, and are
// tagged as "may have been delivered" wherever they're surfaced.
function classifyNetworkError(err) {
    if (err.name === 'AbortError') {
        return { class: 'retryable-ambiguous', code: 'Timeout', message: 'Request timed out waiting for a response from Graph.' };
    }
    const code = err.cause?.code || err.code;
    if (code && CLEAN_TRANSPORT_CODES.has(code)) {
        return { class: 'retryable', code, message: `Connection to Graph failed before the request was sent (${code}).` };
    }
    return { class: 'retryable-ambiguous', code: code || 'NetworkError', message: err.message || 'Network error contacting Graph.' };
}

function classifyHttpError(status, body) {
    const code = body?.error?.code;
    const message = body?.error?.message || `Graph returned HTTP ${status}`;

    if (status === 413) {
        return { class: 'permanent', code: code || 'PayloadTooLarge', message: `${message} (the SMTP SIZE gate should have prevented this — check MAX_MESSAGE_BYTES)` };
    }
    if (status === 429) {
        return { class: 'rate-limited', code: code || 'TooManyRequests', message };
    }
    if (status === 507) {
        return { class: 'retryable-quota', code: code || 'InsufficientStorage', message };
    }
    if (status >= 500) {
        return { class: 'retryable', code: code || `Http${status}`, message };
    }
    // 400 (including ErrorMimeContentInvalidBase64String — our own encoder
    // bug), 403 (ErrorSendAsDenied / missing scope), and anything else
    // unexpected: none of these fix themselves on retry.
    return { class: 'permanent', code: code || `Http${status}`, message };
}

async function attemptSend(accessToken, mimeBuffer) {
    try {
        const res = await fetch(`${config.oauth.graphBase}/me/sendMail`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'text/plain' },
            body: mimeBuffer.toString('base64'),
            signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
        });

        if (res.status === 202) {
            return { status: 202, result: { ok: true } };
        }

        const body = await res.json().catch(() => ({}));

        if (res.status === 429) {
            const retryAfterHeader = res.headers.get('retry-after');
            const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
            return { status: 429, result: { ok: false, ...classifyHttpError(429, body), retryAfterMs } };
        }

        return { status: res.status, result: { ok: false, ...classifyHttpError(res.status, body) } };
    } catch (err) {
        return { status: null, result: { ok: false, ...classifyNetworkError(err) } };
    }
}

// Best-effort cleanup so a failed alias send doesn't accumulate orphan
// drafts in the mailbox. Deliberately swallows its own errors — an orphan
// draft is a minor, visible, user-deletable cleanup issue, not worth
// complicating (or failing) the send classification over.
async function deleteDraft(accessToken, draftId) {
    try {
        await fetch(`${config.oauth.graphBase}/me/messages/${draftId}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
        });
    } catch {
        /* best-effort */
    }
}

// The only path that keeps full MIME fidelity AND lets Graph's `from`
// property be set explicitly: /me/sendMail in MIME mode has no `from`
// property at all (the sender comes from the MIME header, and per an
// unconfirmed report against consumer accounts with aliases, Graph may force
// it back to the primary address regardless of what the header says). JSON
// mode has `from` but would need a full multipart/attachment parser to build
// a `message` object from the relayed MIME — out of scope for a
// zero-dependency relay. So: create a draft from the MIME, PATCH its `from`,
// then send the draft.
//
// UNVERIFIED against a real consumer account. PATCH /me/messages documents
// `from` as updatable ("must correspond to the actual mailbox used" — an
// Outlook.com alias IS the same mailbox, so this plausibly qualifies), but
// Microsoft has never confirmed it for MSA aliases. So step 2's response is
// never trusted at face value — the returned `from` is read back and
// compared to what was requested. Either way the draft is sent: a degraded
// send (from the primary, with the alias surviving as Reply-To — see
// smtp.js) beats a dead letter over an unverified API behavior.
async function attemptSendAsAlias(accessToken, mimeBuffer, from) {
    let createRes;
    try {
        createRes = await fetch(`${config.oauth.graphBase}/me/messages`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'text/plain' },
            body: mimeBuffer.toString('base64'),
            signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
        });
    } catch (err) {
        // Nothing was sent and no draft is known to exist — classify like
        // any other network failure (AbortError still lands on
        // retryable-ambiguous, same as the single-call path).
        return { status: null, result: { ok: false, ...classifyNetworkError(err) } };
    }

    if (createRes.status === 401) return { status: 401, result: null };

    if (createRes.status !== 201) {
        // A clean (non-timeout) failure to even create the draft. No draft
        // exists to clean up and no mail was sent, so fall back to the
        // ordinary single-call path immediately rather than failing this
        // whole send over an alias-specific problem — the MIME buffer
        // already has the alias written into its From: header regardless of
        // which path is used (mime.js writes it once, at spool time), so
        // the fallback still tries to honor it, just without the PATCH.
        const fallback = await attemptSend(accessToken, mimeBuffer);
        return { status: fallback.status, result: { ...fallback.result, aliasOutcome: 'degraded' } };
    }

    const draft = await createRes.json().catch(() => ({}));
    const draftId = draft.id;

    let patchRes;
    try {
        patchRes = await fetch(`${config.oauth.graphBase}/me/messages/${draftId}`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: { emailAddress: { address: from } } }),
            signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
        });
    } catch (err) {
        await deleteDraft(accessToken, draftId);
        return { status: null, result: { ok: false, ...classifyNetworkError(err) } };
    }

    if (patchRes.status === 401) {
        await deleteDraft(accessToken, draftId);
        return { status: 401, result: null };
    }

    // Do not trust a 200 at face value — see the function comment above.
    let aliasOutcome = 'degraded';
    if (patchRes.status === 200) {
        const patched = await patchRes.json().catch(() => ({}));
        const returnedAddress = patched?.from?.emailAddress?.address;
        if (returnedAddress && returnedAddress.toLowerCase() === from.toLowerCase()) aliasOutcome = 'confirmed';
    }

    let sendRes;
    try {
        sendRes = await fetch(`${config.oauth.graphBase}/me/messages/${draftId}/send`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
        });
    } catch (err) {
        // Ambiguous in the same way the single-call path's timeout is: the
        // send may have reached Graph and succeeded. Do NOT delete the
        // draft here — if it actually sent, it's no longer a draft (a
        // DELETE would be a harmless no-op), but if it's genuinely still
        // pending, deleting it would destroy the only record of an outcome
        // we can't yet determine.
        return { status: null, result: { ok: false, ...classifyNetworkError(err), aliasOutcome } };
    }

    if (sendRes.status === 401) {
        await deleteDraft(accessToken, draftId);
        return { status: 401, result: null };
    }

    if (sendRes.status === 202) {
        return { status: 202, result: { ok: true, aliasOutcome } };
    }

    const body = await sendRes.json().catch(() => ({}));
    await deleteDraft(accessToken, draftId);
    return { status: sendRes.status, result: { ok: false, ...classifyHttpError(sendRes.status, body), aliasOutcome } };
}

// Never throws — always resolves to a classified result, so queue.js can
// consume it without its own try/catch around this call. On a first 401 the
// access token is force-refreshed and the send is retried once immediately;
// a second consecutive 401 marks the connection needs_reauth (mail is not
// dropped — queue.js pauses and resumes on reconnect, per oauth.js).
//
// `from`: null (the overwhelming majority of messages) takes the original
// single-call /me/sendMail path, byte-for-byte unchanged from before this
// alias feature existed — that's what keeps the common case at zero
// regression risk. A non-null address is spool time's decision (smtp.js's
// aliasPathAvailable) that this message's sender resolved to a verified,
// user-listed alias AND the aliasForceFrom setting is on AND the connection
// holds the Mail.ReadWrite scope the draft path needs; only then does the
// three-call draft path run.
export async function sendMail(mimeBuffer, { from = null } = {}) {
    let accessToken;
    try {
        accessToken = await oauth.getAccessToken();
    } catch (err) {
        return { ok: false, class: 'auth', code: 'Unauthorized', message: err.message };
    }

    const send = (token) => (from ? attemptSendAsAlias(token, mimeBuffer, from) : attemptSend(token, mimeBuffer));

    let attempt = await send(accessToken);

    if (attempt.status === 401) {
        let forcedToken;
        try {
            forcedToken = await oauth.getAccessToken({ force: true });
        } catch (err) {
            // oauth.js already marked needs_reauth internally in this case
            return { ok: false, class: 'auth', code: 'Unauthorized', message: err.message };
        }

        attempt = await send(forcedToken);

        if (attempt.status === 401) {
            const err = new Error('Graph rejected the access token twice in a row (401).');
            await oauth.markNeedsReauth(err);
            return { ok: false, class: 'auth', code: 'Unauthorized', message: err.message };
        }
    }

    return attempt.result;
}

// Phase-1 alias verification: a single JSON-mode POST /me/sendMail that the
// bridge composes itself (subject/body are fixed, no attachments, no
// relayed MIME to lose fidelity on), so it needs no new scope — Mail.Send
// covers message.from same as it covers the MIME path. Two useful outcomes:
// a 403 ErrorSendAsDenied means the alias genuinely isn't enabled on this
// account (the fix is in Outlook on the web, not in the bridge); a 202 means
// Graph ACCEPTED the from address, which is necessary but not sufficient —
// accepting isn't the same as honoring it in what the recipient sees. That
// last gap is exactly why /api/alias/verify asks a human to check the
// recipient's inbox rather than trusting this call alone.
export async function sendJsonProbe({ from, to }) {
    let accessToken;
    try {
        accessToken = await oauth.getAccessToken();
    } catch (err) {
        return { ok: false, class: 'auth', code: 'Unauthorized', message: err.message };
    }

    const payload = {
        message: {
            subject: 'outlook-oauth-bridge alias probe',
            body: { contentType: 'Text', content: `This is a probe message from the outlook-oauth-bridge web GUI, sent as ${from}, at ${new Date().toISOString()}.` },
            from: { emailAddress: { address: from } },
            toRecipients: [{ emailAddress: { address: to } }],
        },
        saveToSentItems: false,
    };

    try {
        const res = await fetch(`${config.oauth.graphBase}/me/sendMail`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
        });
        if (res.status === 202) return { ok: true };
        const body = await res.json().catch(() => ({}));
        return { ok: false, ...classifyHttpError(res.status, body) };
    } catch (err) {
        return { ok: false, ...classifyNetworkError(err) };
    }
}
