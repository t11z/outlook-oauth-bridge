// Mock for login.microsoftonline.com + graph.microsoft.com. Both are served
// by one http.Server under /login and /graph path prefixes; tests point
// BRIDGE_LOGIN_BASE / BRIDGE_GRAPH_BASE at those prefixes. oauth.js and
// graph.js never hardcode a host, which is what makes this substitution
// possible — see config.js.
import http from 'node:http';
import crypto from 'node:crypto';
// Importing the production header parsers (rather than a hand-rolled mock
// regex) keeps this mock honest — they're pure, independently tested, and
// exactly what a real "did the From header say what we think" check needs.
import { unfoldHeaders, extractAddrSpec, getHeaderValue, normalizeAddress } from '../src/mime.js';

const ERROR_BODIES = {
    invalid_base64: { status: 400, body: { error: { code: 'ErrorMimeContentInvalidBase64String', message: 'The MIME content is not a valid base64 string.' } } },
    send_as_denied: { status: 403, body: { error: { code: 'ErrorSendAsDenied', message: 'The user account does not have the right to send mail on behalf of the specified sending account.' } } },
    too_large: { status: 413, body: { error: { code: 'ErrorAttachmentSizeLimitExceeded', message: 'Message size exceeds fixed maximum.' } } },
    unauthorized: { status: 401, body: { error: { code: 'InvalidAuthenticationToken', message: 'Access token is invalid.' } } },
    server_error: { status: 503, body: { error: { code: 'ErrorInternalServerTransientError', message: 'Transient service error.' } } },
    quota: { status: 507, body: { error: { code: 'ErrorQuotaExceeded', message: 'Mailbox quota exceeded.' } } },
};

// Mirrors the real AADSTS900144 shape so a missing client_id fails the same
// way against the mock as it does against real Microsoft — this is what
// catches the client-id-source-mismatch bug (state.json vs config.oauth)
// that the mock previously let through silently.
const MISSING_CLIENT_ID = { error: 'invalid_request', error_description: "AADSTS900144: The request body must contain the following parameter: 'client_id'." };

export function createFakeGraph() {
    const state = {
        mode: 'success', // sendMail behavior: 'success' | any ERROR_BODIES key | 'rate_limited' | 'hang' | 'reset' | 'invalid_grant'
        devicePendingCount: 0, // number of authorization_pending responses before the device code flow succeeds
        devicePolls: 0,
        refreshTokenCounter: 0,
        account: { id: 'fake-id-0001', displayName: 'Fake User', mail: 'fake@outlook.example', userPrincipalName: 'fake@outlook.example' },
        requests: [],
        // Addresses this fake mailbox may additionally send as, besides
        // account.mail. Deliberately does NOT mirror a real GET /me response
        // with a proxyAddresses/otherMails field — a consumer MSA doesn't
        // return one, so nothing here should imply auto-discovery is
        // possible. Aliases are supplied by the test the same way
        // web/api.js's validated settings.senderAddresses would be.
        aliases: [],
        // Off by default so every test and mode that predates the alias
        // feature keeps passing byte-for-byte unchanged — sendMail accepts
        // any From unless a test opts into enforcement.
        enforceFrom: false,
        // Simulates the one thing this mock can't know for real: whether
        // Graph actually honors a PATCH .../messages/{id} { from } for a
        // consumer account's alias. true = the documented/hoped-for
        // behavior; false = the HEY.com report's silent-override behavior.
        honorPatchFrom: true,
        drafts: new Map(), // id -> { from, sent }
        draftCounter: 0,
    };

    function json(res, status, body) {
        const data = JSON.stringify(body);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(data);
    }

    // Extracts the From: addr-spec from a base64-encoded MIME body, or null
    // if there's no From header at all (matching mime.js's own vocabulary).
    function extractFromMime(bodyBuf) {
        const text = Buffer.from(bodyBuf.toString('utf8'), 'base64').toString('binary');
        const headerBlock = text.split('\r\n\r\n')[0];
        const headers = unfoldHeaders(headerBlock);
        const value = getHeaderValue(headers, 'from');
        return value ? extractAddrSpec(value) : null;
    }

    function isAllowedSender(address) {
        if (!address) return true; // nothing to enforce against
        const addr = normalizeAddress(address);
        return addr === normalizeAddress(state.account.mail) || state.aliases.some((a) => normalizeAddress(a) === addr);
    }

    function tokenPayload() {
        state.refreshTokenCounter++;
        return {
            token_type: 'Bearer',
            scope: 'Mail.Send User.Read',
            expires_in: 3599,
            access_token: `fake-access-token-${crypto.randomBytes(4).toString('hex')}`,
            refresh_token: `fake-refresh-token-${state.refreshTokenCounter}`,
        };
    }

    const MESSAGE_ID_RE = /\/me\/messages\/([^/]+)(?:\/(send))?$/;

    async function handle(req, res, bodyBuf) {
        const url = new URL(req.url, 'http://localhost');
        const messageMatch = url.pathname.match(MESSAGE_ID_RE);

        // Modes that must never send a normal HTTP response — applies to
        // every call that would otherwise actually move mail: the
        // single-call sendMail, creating a draft, and sending a draft.
        // Deliberately NOT applied to PATCH (nothing has been sent yet) or
        // DELETE (best-effort cleanup graph.js already tolerates failing).
        const isSendLikeCall =
            req.method === 'POST' && (url.pathname.endsWith('/sendMail') || url.pathname.endsWith('/me/messages') || messageMatch?.[2] === 'send');
        if (isSendLikeCall) {
            if (state.mode === 'hang') return; // caller's AbortSignal.timeout must fire
            if (state.mode === 'reset') return req.socket.destroy();
        }

        if (url.pathname.endsWith('/devicecode') && req.method === 'POST') {
            const params = new URLSearchParams(bodyBuf.toString('utf8'));
            if (!params.get('client_id')) return json(res, 400, MISSING_CLIENT_ID);
            return json(res, 200, {
                device_code: 'fake-device-code',
                user_code: 'FAKE-CODE',
                verification_uri: 'https://example.invalid/link',
                expires_in: 900,
                interval: 0,
            });
        }

        if (url.pathname.endsWith('/token') && req.method === 'POST') {
            const params = new URLSearchParams(bodyBuf.toString('utf8'));
            if (!params.get('client_id')) return json(res, 400, MISSING_CLIENT_ID);
            const grantType = params.get('grant_type');

            if (grantType === 'urn:ietf:params:oauth:grant-type:device_code') {
                state.devicePolls++;
                if (state.devicePolls <= state.devicePendingCount) {
                    return json(res, 400, { error: 'authorization_pending' });
                }
                return json(res, 200, tokenPayload());
            }

            if (grantType === 'refresh_token') {
                if (state.mode === 'invalid_grant') {
                    return json(res, 400, { error: 'invalid_grant', error_description: 'AADSTS70008: refresh token expired' });
                }
                return json(res, 200, tokenPayload());
            }

            return json(res, 400, { error: 'unsupported_grant_type' });
        }

        if (url.pathname.endsWith('/me') && req.method === 'GET') {
            return json(res, 200, state.account);
        }

        if (url.pathname.endsWith('/sendMail') && req.method === 'POST') {
            if (state.mode === 'rate_limited') {
                res.setHeader('Retry-After', '2');
                return json(res, 429, { error: { code: 'TooManyRequests', message: 'Rate limited.' } });
            }
            if (Object.hasOwn(ERROR_BODIES, state.mode)) {
                const e = ERROR_BODIES[state.mode];
                return json(res, e.status, e.body);
            }
            if (state.enforceFrom) {
                const contentType = req.headers['content-type'] || '';
                let fromAddr = null;
                if (contentType.includes('application/json')) {
                    try {
                        fromAddr = JSON.parse(bodyBuf.toString('utf8'))?.message?.from?.emailAddress?.address || null;
                    } catch {
                        /* malformed JSON body — treated as no From, same as a MIME message without one */
                    }
                } else {
                    fromAddr = extractFromMime(bodyBuf);
                }
                if (!isAllowedSender(fromAddr)) {
                    const e = ERROR_BODIES.send_as_denied;
                    return json(res, e.status, e.body);
                }
            }
            res.writeHead(202);
            return res.end();
        }

        // POST /me/messages — create a draft from MIME content (the first
        // step of graph.js's alias-forcing send path). When honorPatchFrom
        // is false, the draft starts (and PATCH below stays) pinned to the
        // primary address regardless of what the MIME's own From said —
        // simulating the pessimistic real-world report that Exchange always
        // sends as the authenticated mailbox for a consumer account,
        // MIME content included. When true, the draft starts as whatever
        // the MIME claims (the normal, hoped-for case).
        if (url.pathname.endsWith('/me/messages') && req.method === 'POST') {
            if (Object.hasOwn(ERROR_BODIES, state.mode)) {
                const e = ERROR_BODIES[state.mode];
                return json(res, e.status, e.body);
            }
            state.draftCounter++;
            const id = `draft-${state.draftCounter}`;
            const from = state.honorPatchFrom ? extractFromMime(bodyBuf) || state.account.mail : state.account.mail;
            state.drafts.set(id, { from, sent: false });
            return json(res, 201, { id, isDraft: true, from: { emailAddress: { address: from } } });
        }

        if (messageMatch) {
            const [, draftId, action] = messageMatch;
            const draft = state.drafts.get(draftId);

            // PATCH .../me/messages/{id} — the step that tries to force
            // `from`. honorPatchFrom=false is what simulates the pessimistic
            // real-world report: Graph returns 200 but silently keeps the
            // draft's original (primary) address — graph.js must read this
            // response back rather than trust the 200 at face value.
            if (req.method === 'PATCH' && !action) {
                if (!draft) return json(res, 404, { error: { code: 'ErrorItemNotFound', message: 'draft not found' } });
                let patchFrom = null;
                try {
                    patchFrom = JSON.parse(bodyBuf.toString('utf8'))?.from?.emailAddress?.address || null;
                } catch {
                    /* malformed body — leave draft.from untouched, same as honorPatchFrom: false */
                }
                if (state.honorPatchFrom && patchFrom) draft.from = patchFrom;
                return json(res, 200, { id: draftId, isDraft: true, from: { emailAddress: { address: draft.from } } });
            }

            // POST .../me/messages/{id}/send — the final step. Checked
            // against enforceFrom the same way the single-call path is:
            // Graph rejecting an unlisted sender here is exactly what
            // proves (or disproves) that the PATCH actually took effect.
            if (req.method === 'POST' && action === 'send') {
                if (!draft) return json(res, 404, { error: { code: 'ErrorItemNotFound', message: 'draft not found' } });
                if (Object.hasOwn(ERROR_BODIES, state.mode)) {
                    const e = ERROR_BODIES[state.mode];
                    return json(res, e.status, e.body);
                }
                if (state.enforceFrom && !isAllowedSender(draft.from)) {
                    const e = ERROR_BODIES.send_as_denied;
                    return json(res, e.status, e.body);
                }
                draft.sent = true;
                state.drafts.delete(draftId);
                res.writeHead(202);
                return res.end();
            }

            // DELETE .../me/messages/{id} — graph.js's best-effort orphan
            // cleanup. A delete of an already-sent (already-removed) or
            // never-existent draft is still a harmless 204, matching how a
            // real DELETE on a missing resource is treated as best-effort.
            if (req.method === 'DELETE' && !action) {
                state.drafts.delete(draftId);
                res.writeHead(204);
                return res.end();
            }

            if (req.method === 'GET' && !action) {
                if (!draft) return json(res, 404, { error: { code: 'ErrorItemNotFound', message: 'draft not found' } });
                return json(res, 200, { id: draftId, isDraft: !draft.sent, from: { emailAddress: { address: draft.from } } });
            }
        }

        if (url.pathname === '/_control' && req.method === 'POST') {
            Object.assign(state, JSON.parse(bodyBuf.toString('utf8') || '{}'));
            return json(res, 200, { ok: true });
        }

        if (url.pathname === '/_requests' && req.method === 'GET') {
            return json(res, 200, state.requests);
        }

        if (url.pathname === '/_reset' && req.method === 'POST') {
            state.requests = [];
            state.devicePolls = 0;
            state.mode = 'success';
            state.devicePendingCount = 0;
            state.aliases = [];
            state.enforceFrom = false;
            state.honorPatchFrom = true;
            state.drafts = new Map();
            state.draftCounter = 0;
            return json(res, 200, { ok: true });
        }

        res.writeHead(404);
        res.end();
    }

    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const bodyBuf = Buffer.concat(chunks);
            // Recorded before dispatch so hang/reset paths are still visible to assertions.
            // Body is kept (not just length) so tests can assert on the actual MIME bytes
            // Graph received — e.g. From rewrite, Bcc reconciliation, CRLF normalization.
            state.requests.push({ method: req.method, url: req.url, headers: req.headers, bodyLength: bodyBuf.length, body: bodyBuf });
            handle(req, res, bodyBuf).catch((err) => {
                if (!res.headersSent) res.writeHead(500);
                res.end(String(err && err.stack ? err.stack : err));
            });
        });
    });

    return {
        async listen() {
            await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
            const { port } = server.address();
            return {
                loginBase: `http://127.0.0.1:${port}/login`,
                graphBase: `http://127.0.0.1:${port}/graph`,
            };
        },
        async close() {
            await new Promise((resolve) => server.close(resolve));
        },
        setMode(mode) {
            state.mode = mode;
        },
        setDevicePendingCount(n) {
            state.devicePendingCount = n;
        },
        setAliases(aliases) {
            state.aliases = aliases;
        },
        setEnforceFrom(on) {
            state.enforceFrom = on;
        },
        setHonorPatchFrom(on) {
            state.honorPatchFrom = on;
        },
        get requests() {
            return state.requests;
        },
        get account() {
            return state.account;
        },
        get drafts() {
            return state.drafts;
        },
    };
}
