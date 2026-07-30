// Mock for login.microsoftonline.com + graph.microsoft.com. Both are served
// by one http.Server under /login and /graph path prefixes; tests point
// BRIDGE_LOGIN_BASE / BRIDGE_GRAPH_BASE at those prefixes. oauth.js and
// graph.js never hardcode a host, which is what makes this substitution
// possible — see config.js.
import http from 'node:http';
import crypto from 'node:crypto';

const ERROR_BODIES = {
    invalid_base64: { status: 400, body: { error: { code: 'ErrorMimeContentInvalidBase64String', message: 'The MIME content is not a valid base64 string.' } } },
    send_as_denied: { status: 403, body: { error: { code: 'ErrorSendAsDenied', message: 'The user account does not have the right to send mail on behalf of the specified sending account.' } } },
    too_large: { status: 413, body: { error: { code: 'ErrorAttachmentSizeLimitExceeded', message: 'Message size exceeds fixed maximum.' } } },
    unauthorized: { status: 401, body: { error: { code: 'InvalidAuthenticationToken', message: 'Access token is invalid.' } } },
    server_error: { status: 503, body: { error: { code: 'ErrorInternalServerTransientError', message: 'Transient service error.' } } },
    quota: { status: 507, body: { error: { code: 'ErrorQuotaExceeded', message: 'Mailbox quota exceeded.' } } },
};

export function createFakeGraph() {
    const state = {
        mode: 'success', // sendMail behavior: 'success' | any ERROR_BODIES key | 'rate_limited' | 'hang' | 'reset' | 'invalid_grant'
        devicePendingCount: 0, // number of authorization_pending responses before the device code flow succeeds
        devicePolls: 0,
        refreshTokenCounter: 0,
        account: { id: 'fake-id-0001', displayName: 'Fake User', mail: 'fake@outlook.example', userPrincipalName: 'fake@outlook.example' },
        requests: [],
    };

    function json(res, status, body) {
        const data = JSON.stringify(body);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(data);
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

    async function handle(req, res, bodyBuf) {
        const url = new URL(req.url, 'http://localhost');

        // Modes that must never send a normal HTTP response.
        if (url.pathname.endsWith('/sendMail') && req.method === 'POST') {
            if (state.mode === 'hang') return; // caller's AbortSignal.timeout must fire
            if (state.mode === 'reset') return req.socket.destroy();
        }

        if (url.pathname.endsWith('/devicecode') && req.method === 'POST') {
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
            res.writeHead(202);
            return res.end();
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
        get requests() {
            return state.requests;
        },
        get account() {
            return state.account;
        },
    };
}
