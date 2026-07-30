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

// Never throws — always resolves to a classified result, so queue.js can
// consume it without its own try/catch around this call. On a first 401 the
// access token is force-refreshed and the send is retried once immediately;
// a second consecutive 401 marks the connection needs_reauth (mail is not
// dropped — queue.js pauses and resumes on reconnect, per oauth.js).
export async function sendMail(mimeBuffer) {
    let accessToken;
    try {
        accessToken = await oauth.getAccessToken();
    } catch (err) {
        return { ok: false, class: 'auth', code: 'Unauthorized', message: err.message };
    }

    let attempt = await attemptSend(accessToken, mimeBuffer);

    if (attempt.status === 401) {
        let forcedToken;
        try {
            forcedToken = await oauth.getAccessToken({ force: true });
        } catch (err) {
            // oauth.js already marked needs_reauth internally in this case
            return { ok: false, class: 'auth', code: 'Unauthorized', message: err.message };
        }

        attempt = await attemptSend(forcedToken, mimeBuffer);

        if (attempt.status === 401) {
            const err = new Error('Graph rejected the access token twice in a row (401).');
            await oauth.markNeedsReauth(err);
            return { ok: false, class: 'auth', code: 'Unauthorized', message: err.message };
        }
    }

    return attempt.result;
}
