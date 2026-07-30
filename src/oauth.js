import { config } from './config.js';
import { store } from './store.js';
import { events } from './events.js';

const HTTP_TIMEOUT_MS = 30_000;

// Access token only ever lives here, in memory. It has a ~1h lifetime;
// persisting it would add risk (another place a leak could come from) for
// no benefit, since it's trivially re-derived from the refresh token.
let cache = null; // { accessToken, expiresAt, scope }
let refreshPromise = null; // single-flight guard for concurrent getAccessToken() callers
let activePoll = null; // { cancelled: boolean } — the in-flight device code poll, if any
let pending = null; // { userCode, verificationUri, expiresAt, interval } while a device code flow is in progress, else null

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function tokenParams(extra) {
    const params = new URLSearchParams({ client_id: config.oauth.clientId, ...extra });
    // Device code flow needs no client_secret — it's a public-client grant.
    // Only sent if BRIDGE_CLIENT_SECRET is set, as a fallback for tenants
    // where "Allow public client flows" could not be enabled.
    if (config.oauth.clientSecret) params.set('client_secret', config.oauth.clientSecret);
    return params;
}

async function postForm(url, params) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
}

// ---------------------------------------------------------------------------
// Device code flow
// ---------------------------------------------------------------------------

export function cancelDeviceCode() {
    if (activePoll) activePoll.cancelled = true;
    pending = null;
}

export function pendingDeviceCode() {
    return pending;
}

// Starts the device code flow and returns as soon as Microsoft has issued a
// code — a single fast HTTP round trip — WITHOUT waiting for the user to
// actually sign in. The polling loop that follows runs in the background
// (up to `expires_in`, ~15 minutes) and reports its outcome only via SSE
// ('auth' events) and pendingDeviceCode(); a caller that awaited this
// function directly would block for however long the user takes to sign in.
export async function beginDeviceCodeFlow() {
    cancelDeviceCode(); // supersede any flow already in progress

    const { ok, status, body } = await postForm(`${config.oauth.loginBase}/devicecode`, tokenParams({ scope: config.oauth.scope }));
    if (!ok) {
        const message = body.error_description || body.error || `devicecode endpoint returned ${status}`;
        events.emitEvent('auth', { status: 'error', message });
        throw new Error(message);
    }

    const expiresAt = Date.now() + body.expires_in * 1000;
    pending = { userCode: body.user_code, verificationUri: body.verification_uri, expiresAt, interval: body.interval ?? 5 };
    events.emitEvent('auth', { status: 'device_code', userCode: pending.userCode, verificationUri: pending.verificationUri, expiresAt });

    pollDeviceCode(body).catch((err) => {
        pending = null;
        events.emitEvent('auth', { status: 'error', message: err.message });
    });

    return pending;
}

async function pollDeviceCode(deviceCodeResponse) {
    const expiresAt = Date.now() + deviceCodeResponse.expires_in * 1000;
    const poll = (activePoll = { cancelled: false });
    let intervalMs = Math.max(deviceCodeResponse.interval ?? 5, 1) * 1000;

    while (Date.now() < expiresAt) {
        await sleep(intervalMs);
        if (poll.cancelled) {
            pending = null;
            return events.emitEvent('auth', { status: 'cancelled' });
        }

        const result = await postForm(
            `${config.oauth.loginBase}/token`,
            tokenParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCodeResponse.device_code })
        );

        if (result.ok) {
            pending = null;
            return completeConnection(result.body);
        }

        switch (result.body.error) {
            case 'authorization_pending':
                continue;
            case 'slow_down':
                intervalMs += 5000;
                continue;
            case 'authorization_declined':
                pending = null;
                return events.emitEvent('auth', { status: 'declined' });
            case 'expired_token':
                pending = null;
                return events.emitEvent('auth', { status: 'expired' });
            default:
                pending = null;
                return events.emitEvent('auth', {
                    status: 'error',
                    message: result.body.error_description || result.body.error || `token endpoint returned ${result.status}`,
                });
        }
    }

    pending = null;
    events.emitEvent('auth', { status: 'expired' });
}

async function completeConnection(tokenBody) {
    cache = { accessToken: tokenBody.access_token, expiresAt: Date.now() + tokenBody.expires_in * 1000, scope: tokenBody.scope };

    await store.mutate((state) => {
        state.oauth.refreshToken = tokenBody.refresh_token;
        state.oauth.status = 'connected';
        state.oauth.connectedAt = new Date().toISOString();
        state.oauth.lastError = null;
    });

    let account;
    try {
        account = await fetchIdentity();
    } catch (err) {
        return markNeedsReauth(err);
    }

    if (!account.address) {
        return markNeedsReauth(new Error('Could not resolve an email address for this account (both mail and userPrincipalName were empty).'));
    }

    await store.mutate((state) => {
        state.oauth.account = account;
    });
    events.emitEvent('auth', { status: 'connected', account });
}

async function fetchIdentity() {
    const accessToken = await getAccessToken();
    const res = await fetch(`${config.oauth.graphBase}/me?$select=id,displayName,mail,userPrincipalName`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GET /me returned ${res.status}`);
    const me = await res.json();
    return { id: me.id, displayName: me.displayName, address: me.mail || me.userPrincipalName || null };
}

// ---------------------------------------------------------------------------
// Token cache + refresh
// ---------------------------------------------------------------------------

export async function markNeedsReauth(err) {
    await store.mutate((state) => {
        state.oauth.status = 'needs_reauth';
        state.oauth.lastError = { message: err.message, at: new Date().toISOString() };
    });
    events.emitEvent('auth', { status: 'needs_reauth', message: err.message });
}

async function refreshTokenGrant(refreshToken) {
    const { ok, status, body } = await postForm(`${config.oauth.loginBase}/token`, tokenParams({ grant_type: 'refresh_token', refresh_token: refreshToken, scope: config.oauth.scope }));
    if (!ok) {
        const err = new Error(body.error_description || body.error || `token endpoint returned ${status}`);
        err.oauthError = body.error;
        throw err;
    }
    return body;
}

async function doRefresh() {
    const currentRefreshToken = store.state.oauth.refreshToken;
    if (!currentRefreshToken) {
        throw new Error('not connected to an Outlook account');
    }

    let body;
    try {
        body = await refreshTokenGrant(currentRefreshToken);
    } catch (err) {
        if (err.oauthError !== 'invalid_grant') throw err;

        // The in-memory refresh token may be stale (another code path
        // rotated it already) — reread from disk and retry once before
        // giving up and forcing the user through device code again.
        await store.load();
        const diskToken = store.state.oauth.refreshToken;
        if (!diskToken || diskToken === currentRefreshToken) {
            await markNeedsReauth(err);
            throw err;
        }
        try {
            body = await refreshTokenGrant(diskToken);
        } catch (err2) {
            await markNeedsReauth(err2);
            throw err2;
        }
    }

    // MSA rotates the refresh token on every grant and invalidates the old
    // one. The new token MUST be durable on disk before the access token is
    // handed to the caller — if we returned first and crashed before
    // persisting, the user would be permanently locked out.
    await store.mutate((state) => {
        state.oauth.refreshToken = body.refresh_token || currentRefreshToken;
        state.oauth.status = 'connected';
        state.oauth.lastError = null;
    });

    cache = { accessToken: body.access_token, expiresAt: Date.now() + body.expires_in * 1000, scope: body.scope };
    return cache;
}

// force=true bypasses a cached-but-apparently-wrong token (e.g. after a 401
// from Graph) without starting a second concurrent refresh if one is
// already in flight — MSA's rotation means two concurrent refreshes would
// have one invalidate the other.
export async function getAccessToken({ force = false } = {}) {
    if (!force && cache && cache.expiresAt - 300_000 > Date.now()) {
        return cache.accessToken;
    }
    if (!refreshPromise) {
        refreshPromise = doRefresh().finally(() => {
            refreshPromise = null;
        });
    }
    const result = await refreshPromise;
    return result.accessToken;
}

export function tokenStatus() {
    return cache ? { expiresAt: cache.expiresAt } : null;
}

export async function disconnect() {
    cache = null;
    await store.mutate((state) => {
        state.oauth.refreshToken = null;
        state.oauth.account = null;
        state.oauth.status = 'unconfigured';
        state.oauth.connectedAt = null;
        state.oauth.lastError = null;
    });
    events.emitEvent('auth', { status: 'disconnected' });
}

export async function setClientId(clientId) {
    await store.mutate((state) => {
        state.oauth.clientId = clientId;
    });
}
