import crypto from 'node:crypto';
import { store } from '../store.js';
import { SESSION_MAX_AGE_SECONDS, LOGIN_LOCKOUT } from '../config.js';

// Session key derives from the current password hash — changing the
// password therefore invalidates every existing session automatically,
// with no session table and no revocation list to maintain.
function sessionKey() {
    return crypto.createHmac('sha256', store.state.web.sessionSecret).update(store.state.web.passwordHash).digest();
}

function b64url(buf) {
    return buf.toString('base64url');
}

export function createSession() {
    const sid = crypto.randomBytes(16).toString('hex');
    const now = Math.floor(Date.now() / 1000);
    const payloadB64 = b64url(Buffer.from(JSON.stringify({ sid, iat: now, exp: now + SESSION_MAX_AGE_SECONDS })));
    const sig = crypto.createHmac('sha256', sessionKey()).update(payloadB64).digest();
    return { token: `${payloadB64}.${b64url(sig)}`, csrfToken: csrfTokenFor(sid), sid };
}

export function verifySession(token) {
    if (!token || typeof token !== 'string') return null;
    const dot = token.indexOf('.');
    if (dot === -1) return null;
    const payloadB64 = token.slice(0, dot);
    const sigB64 = token.slice(dot + 1);

    let providedSig;
    try {
        providedSig = Buffer.from(sigB64, 'base64url');
    } catch {
        return null;
    }
    const expectedSig = crypto.createHmac('sha256', sessionKey()).update(payloadB64).digest();
    if (providedSig.length !== expectedSig.length || !crypto.timingSafeEqual(providedSig, expectedSig)) return null;

    let payload;
    try {
        payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
}

export function csrfTokenFor(sid) {
    return b64url(crypto.createHmac('sha256', sessionKey()).update(sid).digest());
}

export function timingSafeEqualToken(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Per-IP login throttling: 5 failures locks out starting at 5s, doubling
// each subsequent lockout up to a 15-minute cap. A success clears the
// record entirely. In-memory only — losing this on restart is an
// acceptable tradeoff for a LAN tool, not worth persisting.
const loginAttempts = new Map(); // ip -> { fails, lockUntil, backoffMs }

export function isLoginLocked(ip) {
    const rec = loginAttempts.get(ip);
    return !!(rec && rec.lockUntil && rec.lockUntil > Date.now());
}

export function loginLockRemainingMs(ip) {
    const rec = loginAttempts.get(ip);
    return rec && rec.lockUntil ? Math.max(0, rec.lockUntil - Date.now()) : 0;
}

export function recordLoginFailure(ip) {
    const rec = loginAttempts.get(ip) || { fails: 0, backoffMs: LOGIN_LOCKOUT.baseMs };
    rec.fails++;
    if (rec.fails >= LOGIN_LOCKOUT.threshold) {
        rec.lockUntil = Date.now() + rec.backoffMs;
        rec.backoffMs = Math.min(rec.backoffMs * 2, LOGIN_LOCKOUT.maxMs);
        rec.fails = 0;
    }
    loginAttempts.set(ip, rec);
}

export function recordLoginSuccess(ip) {
    loginAttempts.delete(ip);
}
