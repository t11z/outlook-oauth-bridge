import { store, verifyPassword, hashPassword, generateCredential, isValidId, readSpoolEml, readDeadEml, deleteDeadLetter, listDeadLetters } from '../store.js';
import { events } from '../events.js';
import { queue } from '../queue.js';
import * as oauth from '../oauth.js';
import { config, SESSION_MAX_AGE_SECONDS } from '../config.js';
import { spoolProcessedMessage, configuredPort } from '../smtp.js';
import { shutdown } from '../shutdown.js';
import { createSession, verifySession, csrfTokenFor, timingSafeEqualToken, isLoginLocked, loginLockRemainingMs, recordLoginFailure, recordLoginSuccess } from './session.js';

const SESSION_COOKIE = 'oob_session';
const LOGIN_PAD_MS = 250;
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const EDITABLE_SETTINGS = new Set(['fromRewrite', 'rateLimitPerMin', 'rateLimitPerDay', 'maxQueueDepth', 'queueMaxAgeHours', 'requireTls', 'smtpPort']);
// 465 (SMTPS/implicit TLS) is deliberately not offered — smtp.js hardcodes
// secure: false, so a port expecting a TLS ClientHello on connect would just
// break. Only ports this server can actually speak are listed here.
const SMTP_PORT_OPTIONS = [2525, 587];

function sendJson(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(data);
}

function parseCookies(req) {
    const header = req.headers.cookie;
    if (!header) return {};
    const out = {};
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
    return out;
}

function setSessionCookie(res, token) {
    res.setHeader(
        'Set-Cookie',
        `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}${config.trustTls ? '; Secure' : ''}`
    );
}

function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function readJsonBody(req, maxBytes = 1_000_000) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
                req.destroy();
                reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (!raw) return resolve({});
            try {
                resolve(JSON.parse(raw));
            } catch {
                reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
            }
        });
        req.on('error', reject);
    });
}

function checkOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // same-origin browser requests and non-browser clients don't send one; SameSite+CSRF token cover the gap
    try {
        return new URL(origin).host === req.headers.host;
    } catch {
        return false;
    }
}

// Never spread store.state — web.passwordHash, web.sessionSecret, and
// oauth.refreshToken must never reach the browser. Name every field
// explicitly so a new state.json field can't leak here by accident.
function projectState(csrfToken) {
    const s = store.state;
    return {
        instanceId: s.instanceId,
        csrfToken,
        web: { passwordIsGenerated: s.web.passwordIsGenerated },
        smtp: { username: s.smtp.username, password: s.smtp.password, port: configuredPort() },
        oauth: {
            clientId: oauth.currentClientId(),
            status: s.oauth.status,
            account: s.oauth.account,
            connectedAt: s.oauth.connectedAt,
            lastError: s.oauth.lastError,
            tokenExpiresAt: oauth.tokenStatus()?.expiresAt ?? null,
            pendingDeviceCode: oauth.pendingDeviceCode(),
        },
        settings: s.settings,
        counters: s.counters,
        queue: queue.status(),
    };
}

async function handleLogin(req, res) {
    const ip = req.socket.remoteAddress;
    const start = Date.now();

    if (isLoginLocked(ip)) {
        const retryAfterMs = loginLockRemainingMs(ip);
        res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
        return sendJson(res, 429, { error: 'too_many_attempts', retryAfterMs });
    }

    let body;
    try {
        body = await readJsonBody(req);
    } catch (err) {
        return sendJson(res, err.statusCode || 400, { error: 'invalid_request' });
    }

    const ok = typeof body.password === 'string' && verifyPassword(body.password, store.state.web.passwordHash);

    // Pad to a floor so success/failure are indistinguishable by timing.
    // scrypt itself (~100ms at N=16384) already does most of this for free.
    const elapsed = Date.now() - start;
    if (elapsed < LOGIN_PAD_MS) await new Promise((resolve) => setTimeout(resolve, LOGIN_PAD_MS - elapsed));

    if (!ok) {
        recordLoginFailure(ip);
        return sendJson(res, 401, { error: 'invalid_password' });
    }

    recordLoginSuccess(ip);
    const session = createSession();
    setSessionCookie(res, session.token);
    sendJson(res, 200, { csrfToken: session.csrfToken });
}

// `token` is the raw session cookie value, re-verified on every write (not
// just at connect time) so a session that becomes invalid while the stream
// is open — a password change, a natural expiry — stops receiving events
// immediately instead of leaking them for as long as the TCP connection
// stays open. See ARCHITECTURE.md / the security review this closes.
function handleSse(req, res, token) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(':ok\n\n');

    // Replay so a client that connects after an event fired (e.g. the
    // device-code prompt, or a page reload mid-flow) still sees it.
    for (const event of events.recentFeed()) res.write(`data: ${JSON.stringify(event)}\n\n`);

    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        events.off('event', onEvent);
        if (!res.writableEnded) res.end();
    };

    const onEvent = (event) => {
        if (!verifySession(token)) return close();
        res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    events.on('event', onEvent);

    const heartbeat = setInterval(() => {
        if (!verifySession(token)) return close();
        res.write(':hb\n\n');
    }, 25_000);

    req.on('close', close);
}

async function handleSetClientId(req, res) {
    const body = await readJsonBody(req);
    const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
    if (!GUID_RE.test(clientId)) return sendJson(res, 400, { error: 'invalid_client_id' });
    await oauth.setClientId(clientId);
    sendJson(res, 200, { ok: true });
}

async function handleDeviceStart(req, res) {
    if (!oauth.currentClientId()) return sendJson(res, 400, { error: 'client_id_not_set' });
    try {
        const info = await oauth.beginDeviceCodeFlow();
        sendJson(res, 202, info);
    } catch (err) {
        sendJson(res, 502, { error: 'devicecode_failed', message: err.message });
    }
}

function handleDeviceCancel(req, res) {
    oauth.cancelDeviceCode();
    sendJson(res, 200, { ok: true });
}

async function handleDisconnect(req, res) {
    await oauth.disconnect();
    sendJson(res, 200, { ok: true });
}

async function handlePasswordChange(req, res) {
    const body = await readJsonBody(req);
    if (typeof body.current !== 'string' || typeof body.next !== 'string' || body.next.length < 12) {
        return sendJson(res, 400, { error: 'invalid_request', message: 'next password must be at least 12 characters' });
    }
    if (!verifyPassword(body.current, store.state.web.passwordHash)) {
        return sendJson(res, 401, { error: 'invalid_current_password' });
    }
    await store.mutate((s) => {
        s.web.passwordHash = hashPassword(body.next);
        s.web.passwordIsGenerated = false;
    });
    // The session key derives from passwordHash, so this just invalidated
    // every session including the caller's own — issue a fresh one so they
    // aren't immediately logged out by changing their own password.
    const session = createSession();
    setSessionCookie(res, session.token);
    sendJson(res, 200, { ok: true, csrfToken: session.csrfToken });
}

async function handleSmtpRegenerate(req, res) {
    const password = generateCredential(24);
    await store.mutate((s) => {
        s.smtp.password = password;
    });
    sendJson(res, 200, { username: store.state.smtp.username, password });
}

async function handleSettingsPatch(req, res) {
    const body = await readJsonBody(req);
    const patch = {};
    for (const [key, value] of Object.entries(body)) {
        if (EDITABLE_SETTINGS.has(key)) patch[key] = value;
    }
    if ('fromRewrite' in patch && typeof patch.fromRewrite !== 'boolean') return sendJson(res, 400, { error: 'invalid_fromRewrite' });
    if ('requireTls' in patch && typeof patch.requireTls !== 'boolean') return sendJson(res, 400, { error: 'invalid_requireTls' });
    if ('smtpPort' in patch && !SMTP_PORT_OPTIONS.includes(patch.smtpPort)) return sendJson(res, 400, { error: 'invalid_smtpPort' });
    for (const field of ['rateLimitPerMin', 'rateLimitPerDay', 'maxQueueDepth', 'queueMaxAgeHours']) {
        if (field in patch && !(Number.isFinite(patch[field]) && patch[field] > 0)) return sendJson(res, 400, { error: `invalid_${field}` });
    }
    await store.mutate((s) => Object.assign(s.settings, patch));
    sendJson(res, 200, { settings: store.state.settings });
}

// Responds before tearing anything down — setImmediate gives the response a
// turn of the event loop to actually flush before smtp/queue/web start
// closing, so the caller reliably sees 202 rather than a dropped connection.
// Only actually restarts the process if something supervises it and brings
// it back (Docker's `restart: unless-stopped`, systemd, etc.) — under a bare
// `npm start` this just exits, which the GUI can't detect or prevent.
function handleRestart(req, res) {
    sendJson(res, 202, { ok: true });
    setImmediate(() => shutdown('restart-requested'));
}

async function handleQueueList(req, res) {
    sendJson(res, 200, { active: queue.listActive(), dead: await listDeadLetters() });
}

async function handleQueueItem(req, res, id, action) {
    if (!isValidId(id)) return sendJson(res, 400, { error: 'invalid_id' });
    const isActive = queue.listActive().some((m) => m.id === id);

    if (req.method === 'GET' && action === 'eml') {
        try {
            const buf = isActive ? await readSpoolEml(id) : await readDeadEml(id);
            res.writeHead(200, { 'Content-Type': 'message/rfc822', 'Content-Disposition': `attachment; filename="${id}.eml"` });
            return res.end(buf);
        } catch {
            return sendJson(res, 404, { error: 'not_found' });
        }
    }

    if (req.method === 'POST' && action === 'retry') {
        if (isActive) {
            const ok = await queue.retryNow(id);
            return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'not_found' });
        }
        try {
            await queue.requeueDeadLetter(id);
            return sendJson(res, 200, { ok: true });
        } catch {
            return sendJson(res, 404, { error: 'not_found' });
        }
    }

    if (req.method === 'DELETE' && !action) {
        if (isActive) {
            const ok = await queue.discard(id);
            return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'not_found' });
        }
        await deleteDeadLetter(id);
        return sendJson(res, 200, { ok: true });
    }

    sendJson(res, 404, { error: 'not_found' });
}

async function handleTestMail(req, res) {
    const body = await readJsonBody(req);
    const to = typeof body.to === 'string' ? body.to.trim() : '';
    if (!to.includes('@')) return sendJson(res, 400, { error: 'invalid_to' });
    if (store.state.oauth.status === 'unconfigured') return sendJson(res, 409, { error: 'not_connected' });

    const raw = Buffer.from(
        `Subject: outlook-oauth-bridge test mail\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n` +
            `This is a test message sent from the outlook-oauth-bridge web GUI at ${new Date().toISOString()}.\r\n`
    );
    try {
        const meta = await spoolProcessedMessage({ raw, envelopeFrom: store.state.smtp.username, envelopeTo: [to] });
        sendJson(res, 202, { id: meta.id });
    } catch (err) {
        sendJson(res, 400, { error: err.reason || 'failed', message: err.message });
    }
}

const QUEUE_ITEM_RE = /^\/api\/queue\/([^/]+)(?:\/(retry|eml))?$/;

export async function handleApi(req, res, url) {
    const pathname = url.pathname;

    if (req.method === 'POST' && pathname === '/api/login') {
        try {
            return await handleLogin(req, res);
        } catch (err) {
            return sendJson(res, err.statusCode || 500, { error: 'internal_error' });
        }
    }

    const cookies = parseCookies(req);
    const session = verifySession(cookies[SESSION_COOKIE]);
    if (!session) return sendJson(res, 401, { error: 'unauthorized' });

    if (req.method !== 'GET') {
        if (!checkOrigin(req)) return sendJson(res, 403, { error: 'origin_mismatch' });
        const contentType = req.headers['content-type'] || '';
        if (!contentType.includes('application/json')) return sendJson(res, 415, { error: 'expected application/json' });
        const csrfToken = req.headers['x-csrf-token'];
        if (!timingSafeEqualToken(csrfToken, csrfTokenFor(session.sid))) return sendJson(res, 403, { error: 'csrf' });
    }

    try {
        if (req.method === 'POST' && pathname === '/api/logout') {
            clearSessionCookie(res);
            return sendJson(res, 200, { ok: true });
        }
        // Handing the CSRF token back here — not just from /api/login — is what lets a
        // page reload with an existing session cookie (no fresh login) still make
        // authenticated POST requests. Without this, the browser tab's csrfToken
        // variable stays unset after a reload and every mutating request gets a
        // bare 403 { error: 'csrf' }, e.g. from the "Save & connect" client-id form.
        if (req.method === 'GET' && pathname === '/api/state') return sendJson(res, 200, projectState(csrfTokenFor(session.sid)));
        if (req.method === 'GET' && pathname === '/api/events') return handleSse(req, res, cookies[SESSION_COOKIE]);

        if (req.method === 'POST' && pathname === '/api/oauth/client') return await handleSetClientId(req, res);
        if (req.method === 'POST' && pathname === '/api/oauth/device/start') return await handleDeviceStart(req, res);
        if (req.method === 'POST' && pathname === '/api/oauth/device/cancel') return handleDeviceCancel(req, res);
        if (req.method === 'POST' && pathname === '/api/oauth/disconnect') return await handleDisconnect(req, res);

        if (req.method === 'POST' && pathname === '/api/password') return await handlePasswordChange(req, res);
        if (req.method === 'POST' && pathname === '/api/smtp/regenerate') return await handleSmtpRegenerate(req, res);
        if (req.method === 'POST' && pathname === '/api/settings') return await handleSettingsPatch(req, res);
        if (req.method === 'POST' && pathname === '/api/system/restart') return handleRestart(req, res);

        if (req.method === 'GET' && pathname === '/api/queue') return await handleQueueList(req, res);
        if (req.method === 'POST' && pathname === '/api/test-mail') return await handleTestMail(req, res);

        const queueMatch = pathname.match(QUEUE_ITEM_RE);
        if (queueMatch) return await handleQueueItem(req, res, queueMatch[1], queueMatch[2]);

        sendJson(res, 404, { error: 'not_found' });
    } catch (err) {
        sendJson(res, err.statusCode || 500, { error: 'internal_error', message: err.message });
    }
}
