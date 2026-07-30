// Regression test for a "csrf" 403 on every POST after a page reload (or any
// resumed session that skips /api/login): app.js's module-scoped csrfToken
// variable was only ever populated from the /api/login and /api/password
// responses. A reload with a still-valid session cookie goes straight to
// GET /api/state, so csrfToken stayed null and every subsequent POST — e.g.
// "Save & connect" on the client-id form — got a bare 403 { error: 'csrf' }
// with the cookie itself perfectly valid. Fixed by having /api/state hand
// back a token too, and having the client's api() helper pick it up from
// any response, not just login/password.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const HTTP_PORT = 8299;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const FAKE_CLIENT_ID = '11111111-2222-3333-4444-555555555555';

let dataDir;
let store;
let queue;
let web;
let webPassword;

function cookieFrom(res) {
    const setCookie = res.headers.get('set-cookie');
    return setCookie ? setCookie.split(';')[0] : null;
}

before(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oob-csrf-'));
    process.env.BRIDGE_DATA_DIR = dataDir;
    process.env.BRIDGE_HTTP_PORT = String(HTTP_PORT);
    delete process.env.BRIDGE_CLIENT_ID;

    const storeMod = await import('../src/store.js');
    store = storeMod.store;
    await storeMod.preflight();
    const { generated } = await store.load();
    webPassword = generated.webPassword;

    ({ queue } = await import('../src/queue.js'));
    web = await import('../src/web/server.js');
    await queue.start();
    await web.start();
});

after(async () => {
    await queue.stop();
    await web.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
});

test('a resumed session (cookie only, no fresh login) can still make an authenticated POST, because /api/state hands back a CSRF token', async () => {
    const loginRes = await fetch(`${BASE}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: webPassword }),
    });
    assert.equal(loginRes.status, 200);
    const cookie = cookieFrom(loginRes);
    assert.ok(cookie, 'expected /api/login to set a session cookie');
    // Deliberately never read loginRes's own csrfToken — simulates a fresh
    // page load where app.js's module state (including csrfToken) has been
    // reset but the browser still carries the session cookie.

    const stateRes = await fetch(`${BASE}/api/state`, { headers: { Cookie: cookie } });
    assert.equal(stateRes.status, 200);
    const state = await stateRes.json();
    assert.equal(typeof state.csrfToken, 'string');
    assert.ok(state.csrfToken.length > 0, 'expected /api/state to carry a usable CSRF token for the resumed session');

    const saveRes = await fetch(`${BASE}/api/oauth/client`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': state.csrfToken },
        body: JSON.stringify({ clientId: FAKE_CLIENT_ID }),
    });
    const saveBody = await saveRes.json().catch(() => null);
    assert.equal(saveRes.status, 200, `expected Save & connect to succeed with the token from /api/state, got ${saveRes.status} ${JSON.stringify(saveBody)}`);
    assert.equal(store.state.oauth.clientId, FAKE_CLIENT_ID);
});

test('the same POST without any CSRF token reproduces the reported bare "csrf" error, confirming the header is what matters', async () => {
    const loginRes = await fetch(`${BASE}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: webPassword }),
    });
    const cookie = cookieFrom(loginRes);

    const saveRes = await fetch(`${BASE}/api/oauth/client`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ clientId: FAKE_CLIENT_ID }),
    });
    assert.equal(saveRes.status, 403);
    const body = await saveRes.json();
    assert.equal(body.error, 'csrf');
});
