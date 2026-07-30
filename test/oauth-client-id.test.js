// Regression test for the AADSTS900144 bug: a client ID saved through the
// GUI (state.json, via oauth.setClientId) must be the one actually sent to
// Microsoft, even when BRIDGE_CLIENT_ID is unset. oauth.js used to build
// every request from config.oauth.clientId — env-only, frozen at import —
// while the GUI wrote to store.state.oauth.clientId. Nothing reconciled the
// two, so the outgoing client_id was silently empty.
//
// config.oauth.clientId is forced empty here by mutating the imported
// config object directly, not by leaving BRIDGE_CLIENT_ID unset in
// process.env — config.js unconditionally calls process.loadEnvFile(),
// so a stray local .env could otherwise inject a real client ID and make
// this test pass for the wrong reason regardless of the fix.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFakeGraph } from './fake-graph.js';

const FAKE_CLIENT_ID = '11111111-2222-3333-4444-555555555555';

let fg;
let dataDir;
let store;
let oauth;
let config;

before(async () => {
    fg = createFakeGraph();
    const { loginBase, graphBase } = await fg.listen();

    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oob-client-id-'));
    process.env.BRIDGE_LOGIN_BASE = loginBase;
    process.env.BRIDGE_GRAPH_BASE = graphBase;
    process.env.BRIDGE_DATA_DIR = dataDir;
    delete process.env.BRIDGE_CLIENT_ID;

    const configMod = await import('../src/config.js');
    config = configMod.config;
    config.oauth.clientId = ''; // simulate BRIDGE_CLIENT_ID unset, regardless of the real environment

    const storeMod = await import('../src/store.js');
    store = storeMod.store;
    await storeMod.preflight();
    await store.load();

    oauth = await import('../src/oauth.js');
});

after(async () => {
    await fg.close();
    await fs.rm(dataDir, { recursive: true, force: true });
});

test('a client ID saved via the GUI (state.json) is sent to Microsoft even when config.oauth.clientId is empty', async () => {
    assert.equal(config.oauth.clientId, '', 'setup: env-derived client id must be empty for this test to be meaningful');

    await oauth.setClientId(FAKE_CLIENT_ID);
    assert.equal(store.state.oauth.clientId, FAKE_CLIENT_ID);

    fg.setMode('success');
    await oauth.beginDeviceCodeFlow();

    const deviceCodeRequest = fg.requests.find((r) => r.url.endsWith('/devicecode'));
    assert.ok(deviceCodeRequest, 'expected a /devicecode request to have been sent');
    const sentClientId = new URLSearchParams(deviceCodeRequest.body.toString('utf8')).get('client_id');
    assert.equal(sentClientId, FAKE_CLIENT_ID, 'the client_id sent to Microsoft must match the one saved through the GUI');

    oauth.cancelDeviceCode();
});

test('beginDeviceCodeFlow fails locally, without any HTTP request, when no client ID is configured anywhere', async () => {
    // Reset both sources: no env value (already empty) and no state value.
    await oauth.setClientId('');
    assert.equal(config.oauth.clientId, '');
    assert.equal(store.state.oauth.clientId, '');

    fg.requests.length = 0;
    await assert.rejects(() => oauth.beginDeviceCodeFlow(), /client ID not configured/);
    assert.equal(fg.requests.length, 0, 'expected no HTTP request to be sent when the client ID is missing');
});
