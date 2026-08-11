// Covers settings.senderAddresses/defaultSender/aliasForceFrom validation at
// the web API layer: what web/api.js's normalizeSenderAddresses and the
// cross-field defaultSender check accept/reject, and that a rejected patch
// never partially persists (mirrors smtp-port.test.js's "a rejected port
// must not be persisted" pattern — that's what catches partial-apply bugs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const HTTP_PORT = 8499;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;

let dataDir;
let store;
let queue;
let web;
let webPassword;
let cookie;
let csrfToken;

function cookieFrom(res) {
    const setCookie = res.headers.get('set-cookie');
    return setCookie ? setCookie.split(';')[0] : null;
}

async function patchSettings(body) {
    const res = await fetch(`${BASE}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken },
        body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
}

before(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oob-sender-address-'));
    process.env.BRIDGE_DATA_DIR = dataDir;
    process.env.BRIDGE_HTTP_PORT = String(HTTP_PORT);

    const storeMod = await import('../src/store.js');
    store = storeMod.store;
    await storeMod.preflight();
    const { generated } = await store.load();
    webPassword = generated.webPassword;

    // A connected account is what makes the "primary is always allowed /
    // never listed" and cross-field defaultSender checks meaningful.
    await store.mutate((s) => {
        s.oauth.status = 'connected';
        s.oauth.account = { id: 'test-id', displayName: 'Test User', address: 'me@outlook.example' };
    });

    ({ queue } = await import('../src/queue.js'));
    web = await import('../src/web/server.js');
    await queue.start();
    await web.start();

    const loginRes = await fetch(`${BASE}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: webPassword }),
    });
    cookie = cookieFrom(loginRes);
    ({ csrfToken } = await loginRes.json());
});

after(async () => {
    await queue.stop();
    await web.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
});

test('a valid sender address list persists and round-trips through GET /api/state', async () => {
    const { status, data } = await patchSettings({ senderAddresses: [{ address: 'scans@outlook.example', displayName: 'Office Scanner' }] });
    assert.equal(status, 200);
    assert.deepEqual(data.settings.senderAddresses, [{ address: 'scans@outlook.example', displayName: 'Office Scanner' }]);

    const stateRes = await fetch(`${BASE}/api/state`, { headers: { Cookie: cookie } });
    const state = await stateRes.json();
    assert.deepEqual(state.settings.senderAddresses, [{ address: 'scans@outlook.example', displayName: 'Office Scanner' }]);

    await patchSettings({ senderAddresses: [] });
});

test('rejects a list longer than MAX_SENDER_ADDRESSES and persists nothing', async () => {
    const before = await fetch(`${BASE}/api/state`, { headers: { Cookie: cookie } }).then((r) => r.json());
    const tooMany = Array.from({ length: 21 }, (_, i) => ({ address: `alias${i}@outlook.example` }));
    const { status, data } = await patchSettings({ senderAddresses: tooMany });
    assert.equal(status, 400);
    assert.equal(data.error, 'invalid_senderAddresses');

    const after = await fetch(`${BASE}/api/state`, { headers: { Cookie: cookie } }).then((r) => r.json());
    assert.deepEqual(after.settings.senderAddresses, before.settings.senderAddresses, 'a rejected list must not be persisted');
});

test('rejects malformed addresses and persists nothing', async () => {
    const malformed = ['no-at', '<a@b.example>', 'a@b.example, c@d.example', 'a@b.example\r\nX-Injected: y', 'a@localhost'];
    for (const address of malformed) {
        const before = await fetch(`${BASE}/api/state`, { headers: { Cookie: cookie } }).then((r) => r.json());
        const { status, data } = await patchSettings({ senderAddresses: [{ address }] });
        assert.equal(status, 400, `expected "${address}" to be rejected`);
        assert.equal(data.error, 'invalid_senderAddresses');
        const after = await fetch(`${BASE}/api/state`, { headers: { Cookie: cookie } }).then((r) => r.json());
        assert.deepEqual(after.settings.senderAddresses, before.settings.senderAddresses, `a rejected address ("${address}") must not be persisted`);
    }
});

test('rejects a display name containing CR/LF (header injection) and persists nothing', async () => {
    const before = await fetch(`${BASE}/api/state`, { headers: { Cookie: cookie } }).then((r) => r.json());
    const { status, data } = await patchSettings({ senderAddresses: [{ address: 'scans@outlook.example', displayName: 'Evil\r\nBcc: attacker@evil.example' }] });
    assert.equal(status, 400);
    assert.equal(data.error, 'invalid_senderAddresses');
    const after = await fetch(`${BASE}/api/state`, { headers: { Cookie: cookie } }).then((r) => r.json());
    assert.deepEqual(after.settings.senderAddresses, before.settings.senderAddresses);
});

test('deduplicates addresses case-insensitively, keeping the first occurrence casing', async () => {
    const { status, data } = await patchSettings({
        senderAddresses: [
            { address: 'Scans@Outlook.Example', displayName: 'First' },
            { address: 'scans@outlook.example', displayName: 'Second' },
        ],
    });
    assert.equal(status, 200);
    assert.deepEqual(data.settings.senderAddresses, [{ address: 'Scans@Outlook.Example', displayName: 'First' }]);
    await patchSettings({ senderAddresses: [] });
});

test('drops an entry equal to the connected account own address', async () => {
    const { status, data } = await patchSettings({
        senderAddresses: [
            { address: 'me@outlook.example', displayName: 'Should be dropped' },
            { address: 'scans@outlook.example', displayName: null },
        ],
    });
    assert.equal(status, 200);
    assert.deepEqual(data.settings.senderAddresses, [{ address: 'scans@outlook.example', displayName: null }]);
    await patchSettings({ senderAddresses: [] });
});

test('rejects a defaultSender outside the merged allowed set', async () => {
    const { status, data } = await patchSettings({ defaultSender: 'not-listed@outlook.example' });
    assert.equal(status, 400);
    assert.equal(data.error, 'invalid_defaultSender');
});

test('accepts defaultSender and senderAddresses together, validated against the merged result', async () => {
    const { status, data } = await patchSettings({
        senderAddresses: [{ address: 'scans@outlook.example', displayName: null }],
        defaultSender: 'scans@outlook.example',
    });
    assert.equal(status, 200);
    assert.equal(data.settings.defaultSender, 'scans@outlook.example');
    await patchSettings({ senderAddresses: [], defaultSender: null });
});

test('removing the address that is the current default resets defaultSender to null instead of rejecting', async () => {
    await patchSettings({ senderAddresses: [{ address: 'scans@outlook.example', displayName: null }], defaultSender: 'scans@outlook.example' });

    const { status, data } = await patchSettings({ senderAddresses: [] });
    assert.equal(status, 200);
    assert.equal(data.defaultSenderReset, true);
    assert.equal(data.settings.defaultSender, null);
});

test('aliasForceFrom controls whether oauth.currentScope() requests Mail.ReadWrite', async () => {
    const oauth = await import('../src/oauth.js');

    await patchSettings({ aliasForceFrom: false });
    assert.doesNotMatch(oauth.currentScope(), /Mail\.ReadWrite/);

    const { status } = await patchSettings({ aliasForceFrom: true });
    assert.equal(status, 200);
    assert.match(oauth.currentScope(), /Mail\.ReadWrite/);

    await patchSettings({ aliasForceFrom: false });
});

test('rejects a non-boolean aliasForceFrom', async () => {
    const { status, data } = await patchSettings({ aliasForceFrom: 'yes' });
    assert.equal(status, 400);
    assert.equal(data.error, 'invalid_aliasForceFrom');
});
