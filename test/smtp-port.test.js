// Covers the configurable SMTP listen port: seeding, the settings PATCH
// enum validation (only 2525/587 — 465 is deliberately excluded, see
// EDITABLE_SETTINGS/SMTP_PORT_OPTIONS in web/api.js, because smtp.js
// hardcodes secure: false and can't speak implicit TLS), and that a bind
// failure rejects cleanly instead of hanging or crashing the process.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const HTTP_PORT = 8399;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;

let dataDir;
let store;
let smtp;
let queue;
let web;
let webPassword;

function cookieFrom(res) {
    const setCookie = res.headers.get('set-cookie');
    return setCookie ? setCookie.split(';')[0] : null;
}

before(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oob-smtp-port-'));
    process.env.BRIDGE_DATA_DIR = dataDir;
    process.env.BRIDGE_HTTP_PORT = String(HTTP_PORT);
    delete process.env.BRIDGE_SMTP_PORT; // exercise config.js's own 2525 default
    // Bind to the loopback address specifically (not the 0.0.0.0 default) so
    // the bind-conflict test below collides on the exact same address:port —
    // a 0.0.0.0-vs-127.0.0.1 overlap does not reliably conflict on Windows.
    // This also rebinds the web server started below to 127.0.0.1, which is
    // fine and deliberate: BASE already targets 127.0.0.1.
    process.env.BRIDGE_BIND = '127.0.0.1';

    const storeMod = await import('../src/store.js');
    store = storeMod.store;
    await storeMod.preflight();
    const { generated } = await store.load();
    webPassword = generated.webPassword;

    smtp = await import('../src/smtp.js');
    ({ queue } = await import('../src/queue.js'));
    web = await import('../src/web/server.js');
    await queue.start();
    await web.start();
});

after(async () => {
    await smtp.stop(); // in case a test above left it running (e.g. a failed assertion)
    await queue.stop();
    await web.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
});

test('settings.smtpPort is seeded from config.smtpPort (BRIDGE_SMTP_PORT, default 2525) on first run', () => {
    assert.equal(store.state.settings.smtpPort, 2525);
    assert.equal(smtp.configuredPort(), 2525);
});

test('configuredPort() falls back to config.smtpPort for a state.json predating this setting', () => {
    const saved = store.state.settings.smtpPort;
    delete store.state.settings.smtpPort;
    assert.equal(smtp.configuredPort(), 2525);
    store.state.settings.smtpPort = saved;
});

test('POST /api/settings accepts 587 and persists it', async () => {
    const loginRes = await fetch(`${BASE}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: webPassword }),
    });
    const cookie = cookieFrom(loginRes);
    const { csrfToken } = await loginRes.json();

    const res = await fetch(`${BASE}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ smtpPort: 587 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.settings.smtpPort, 587);
    assert.equal(store.state.settings.smtpPort, 587);
    assert.equal(smtp.configuredPort(), 587, 'the change takes effect on next restart, but the read must reflect it immediately');

    // Reset for the remaining tests / next boot.
    await store.mutate((s) => {
        s.settings.smtpPort = 2525;
    });
});

test('POST /api/settings rejects 465 (SMTPS/implicit TLS — not implemented) and any other non-standard port', async () => {
    const loginRes = await fetch(`${BASE}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: webPassword }),
    });
    const cookie = cookieFrom(loginRes);
    const { csrfToken } = await loginRes.json();

    for (const badPort of [465, 25, 9999]) {
        const res = await fetch(`${BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken },
            body: JSON.stringify({ smtpPort: badPort }),
        });
        assert.equal(res.status, 400, `expected port ${badPort} to be rejected`);
        const body = await res.json();
        assert.equal(body.error, 'invalid_smtpPort');
        assert.equal(store.state.settings.smtpPort, 2525, `a rejected port must not be persisted (tried ${badPort})`);
    }
});

test('GET /api/state reports smtp.port from settings, not a stale config value', async () => {
    await store.mutate((s) => {
        s.settings.smtpPort = 587;
    });
    const loginRes = await fetch(`${BASE}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: webPassword }),
    });
    const cookie = cookieFrom(loginRes);
    const stateRes = await fetch(`${BASE}/api/state`, { headers: { Cookie: cookie } });
    const state = await stateRes.json();
    assert.equal(state.smtp.port, 587);
    await store.mutate((s) => {
        s.settings.smtpPort = 2525;
    });
});

test('smtp.start() rejects cleanly (not a hang or a crash) when the configured port is already taken, and leaves the module free to retry', async () => {
    const blocker = net.createServer();
    await new Promise((resolve, reject) => {
        blocker.once('error', reject);
        blocker.listen(0, '127.0.0.1', resolve); // same address smtp.js binds to (BRIDGE_BIND=127.0.0.1 above)
    });
    const takenPort = blocker.address().port;

    try {
        await store.mutate((s) => {
            s.settings.smtpPort = takenPort;
        });

        await assert.rejects(() => smtp.start(), /EADDRINUSE/);
    } finally {
        // Never leave a listening socket open on assertion failure — that's
        // exactly what wedged this file's process open on a prior run.
        blocker.close();
        await store.mutate((s) => {
            s.settings.smtpPort = 2525;
        });
    }

    // A free port must still work after the failed attempt above — proves
    // start() reset its internal server reference on failure instead of
    // wedging the module in a half-started state.
    await smtp.start();
    await smtp.stop();
});
