// Full-stack test: a real SMTPServer, a real web server, a real queue
// worker — all talking to a mocked login.microsoftonline.com /
// graph.microsoft.com (test/fake-graph.js). Exercises what only an
// end-to-end test can: real SMTP protocol codes, the actual bytes Graph
// receives after mime.js processing, and the modules wired together the
// way index.js wires them. Retry-after-backoff timing itself is covered by
// queue.js's own logic (verified separately) — this file keeps to what
// doesn't require waiting out real backoff delays.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { createFakeGraph } from './fake-graph.js';

const SMTP_PORT = 25299;
const HTTP_PORT = 8199;

let fg;
let dataDir;
let smtp;
let queue;
let web;
let store;
let oauth;

function transporter(overrides = {}) {
    return nodemailer.createTransport({
        host: '127.0.0.1',
        port: SMTP_PORT,
        secure: false,
        auth: { user: store.state.smtp.username, pass: store.state.smtp.password },
        connectionTimeout: 5000,
        ...overrides,
    });
}

async function waitUntil(predicate, maxMs = 5000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        if (await predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
}

before(async () => {
    fg = createFakeGraph();
    const { loginBase, graphBase } = await fg.listen();

    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oob-e2e-'));
    process.env.BRIDGE_LOGIN_BASE = loginBase;
    process.env.BRIDGE_GRAPH_BASE = graphBase;
    process.env.BRIDGE_CLIENT_ID = 'e2e-client-id';
    process.env.BRIDGE_DATA_DIR = dataDir;
    process.env.BRIDGE_SMTP_PORT = String(SMTP_PORT);
    process.env.BRIDGE_HTTP_PORT = String(HTTP_PORT);

    const storeMod = await import('../src/store.js');
    store = storeMod.store;
    await storeMod.preflight();
    await store.load();

    oauth = await import('../src/oauth.js');
    ({ queue } = await import('../src/queue.js'));
    smtp = await import('../src/smtp.js');
    web = await import('../src/web/server.js');

    await smtp.start();
    await queue.start();
    await web.start();

    fg.setMode('success');
    await oauth.beginDeviceCodeFlow();
    const connected = await waitUntil(() => store.state.oauth.status === 'connected');
    assert.ok(connected, 'setup: expected the fake device code flow to connect');
});

after(async () => {
    await queue.stop();
    await smtp.stop();
    await web.stop();
    await fg.close();
    await fs.rm(dataDir, { recursive: true, force: true });
});

test('accepts a message with a ~1.8MB attachment, rewrites From, reconciles Bcc, and delivers correctly-formed MIME to Graph', async () => {
    fg.setMode('success');
    const sentBefore = store.counters?.sent ?? store.state.counters.sent;

    // Deliberately not "tiny": exercises the streaming spool path
    // (onData -> spoolTmpFileHandle -> multi-chunk write) rather than
    // something that fits in a single buffer. Sized so base64 expansion
    // (4/3) still lands safely under the 3,000,000-byte MAX_MESSAGE_BYTES
    // gate: ~1.8MB raw -> ~2.4MB in the final MIME.
    const attachment = Buffer.alloc(1_800_000, 'A');

    const t = transporter();
    const info = await t.sendMail({
        from: '"HP LaserJet 4000" <printer@lan.local>',
        to: 'visible@example.com',
        bcc: 'secret@example.com',
        subject: 'Scan with attachment',
        text: 'scanned document attached\nsecond line\n',
        attachments: [{ filename: 'scan.bin', content: attachment }],
    });
    assert.match(info.response, /^250/);

    const delivered = await waitUntil(() => store.state.counters.sent > sentBefore);
    assert.ok(delivered, 'expected the message to be delivered via the queue');

    const sendMailRequest = fg.requests.filter((r) => r.url.endsWith('/sendMail')).at(-1);
    assert.ok(sendMailRequest, 'expected Graph to have received a sendMail POST');

    const mime = Buffer.from(sendMailRequest.body.toString('utf8'), 'base64').toString('binary');
    const headerBlock = mime.split('\r\n\r\n')[0];

    assert.match(headerBlock, /From: "HP LaserJet 4000" <fake@outlook\.example>\r\n/, 'From should be rewritten to the connected account, display name preserved');
    assert.match(headerBlock, /Reply-To: printer@lan\.local\r\n/, 'original From address should be preserved as Reply-To');
    assert.match(headerBlock, /Bcc: secret@example\.com\r\n/, 'envelope-only recipient should be folded into Bcc');
    // Last header before the \r\n\r\n boundary, which split() already
    // consumed — so no trailing \r\n is expected here.
    assert.match(headerBlock, /X-Outlook-Bridge-Id: [0-9A-Z]{26}$/, 'should be tagged with the spool message id');

    // No bare LF anywhere — normalizeCrlf must have run on the whole message.
    assert.doesNotMatch(mime, /[^\r]\n/, 'message must be fully CRLF-normalized, no bare LF');
});

test('rejects an oversized message with 552 before it reaches the queue', async () => {
    const t = transporter();
    const oversized = 'A'.repeat(4_000_000); // exceeds MAX_MESSAGE_BYTES (3,000,000) once wrapped in a MIME body
    await assert.rejects(
        () => t.sendMail({ from: 'a@x', to: 'b@y', subject: 'too big', text: oversized }),
        (err) => {
            assert.equal(err.responseCode, 552);
            return true;
        }
    );
});

test('rejects bad SMTP credentials with 535', async () => {
    const t = transporter({ auth: { user: 'wrong', pass: 'wrong' } });
    await assert.rejects(
        () => t.sendMail({ from: 'a@x', to: 'b@y', subject: 'x', text: 'hi' }),
        (err) => {
            assert.equal(err.responseCode, 535);
            return true;
        }
    );
});

test('a transient Graph error (503) is classified as retryable and queues for another attempt', async () => {
    fg.setMode('server_error');
    const t = transporter();
    const info = await t.sendMail({ from: 'a@x', to: 'b@y', subject: 'transient failure probe', text: 'hi' });
    assert.match(info.response, /^250/); // still accepted at SMTP level — the failure is Graph-side, discovered async

    const retried = await waitUntil(() => queue.listActive().some((m) => m.subject === 'transient failure probe' && m.attempts >= 1));
    assert.ok(retried, 'expected a retryable Graph error to schedule another attempt rather than dead-letter immediately');

    fg.setMode('success'); // let it recover so it doesn't sit retrying for the rest of the suite
});

// ---------------------------------------------------------------------------
// Sender addresses (aliases)
// ---------------------------------------------------------------------------

test('an allowed alias already in the From: header is delivered unrewritten, with no Reply-To added', async () => {
    fg.setMode('success');
    fg.setEnforceFrom(true);
    fg.setAliases(['scans@outlook.example']);
    await store.mutate((s) => {
        s.settings.senderAddresses = [{ address: 'scans@outlook.example', displayName: null }];
    });
    const sentBefore = store.state.counters.sent;

    const t = transporter();
    const info = await t.sendMail({ from: 'scans@outlook.example', to: 'visible@example.com', subject: 'alias header test', text: 'hi\n' });
    assert.match(info.response, /^250/);

    const delivered = await waitUntil(() => store.state.counters.sent > sentBefore);
    assert.ok(delivered, 'expected the alias-From message to be delivered');

    const req = fg.requests.filter((r) => r.url.endsWith('/sendMail')).at(-1);
    const mime = Buffer.from(req.body.toString('utf8'), 'base64').toString('binary');
    const headerBlock = mime.split('\r\n\r\n')[0];
    assert.match(headerBlock, /From: scans@outlook\.example\r\n/, 'From should be passed through byte-identical, not rewritten');
    assert.doesNotMatch(headerBlock, /Reply-To:/, 'nothing was rewritten, so there is nothing to preserve a Reply-To for');

    fg.setEnforceFrom(false);
    fg.setAliases([]);
    await store.mutate((s) => {
        s.settings.senderAddresses = [];
    });
});

test('an allowed alias set only via the envelope MAIL FROM rewrites an unrelated header From, preserving it as Reply-To', async () => {
    fg.setMode('success');
    fg.setEnforceFrom(true);
    fg.setAliases(['scans@outlook.example']);
    await store.mutate((s) => {
        s.settings.senderAddresses = [{ address: 'scans@outlook.example', displayName: null }];
    });
    const sentBefore = store.state.counters.sent;

    const t = transporter();
    const info = await t.sendMail({
        from: '"HP LaserJet 4000" <printer@lan.local>',
        envelope: { from: 'scans@outlook.example', to: ['visible@example.com'] },
        to: 'visible@example.com',
        subject: 'alias envelope test',
        text: 'hi\n',
    });
    assert.match(info.response, /^250/);

    const delivered = await waitUntil(() => store.state.counters.sent > sentBefore);
    assert.ok(delivered, 'expected the envelope-alias message to be delivered');

    const req = fg.requests.filter((r) => r.url.endsWith('/sendMail')).at(-1);
    const mime = Buffer.from(req.body.toString('utf8'), 'base64').toString('binary');
    const headerBlock = mime.split('\r\n\r\n')[0];
    assert.match(headerBlock, /From: "HP LaserJet 4000" <scans@outlook\.example>\r\n/);
    assert.match(headerBlock, /Reply-To: printer@lan\.local\r\n/);

    fg.setEnforceFrom(false);
    fg.setAliases([]);
    await store.mutate((s) => {
        s.settings.senderAddresses = [];
    });
});

test('an unlisted sender still falls back to the primary address with Reply-To, even with aliases configured', async () => {
    fg.setMode('success');
    await store.mutate((s) => {
        s.settings.senderAddresses = [{ address: 'scans@outlook.example', displayName: null }];
    });
    const sentBefore = store.state.counters.sent;

    const t = transporter();
    const info = await t.sendMail({ from: '"Random Device" <random@lan.local>', to: 'visible@example.com', subject: 'unlisted sender test', text: 'hi\n' });
    assert.match(info.response, /^250/);

    const delivered = await waitUntil(() => store.state.counters.sent > sentBefore);
    assert.ok(delivered);

    const req = fg.requests.filter((r) => r.url.endsWith('/sendMail')).at(-1);
    const mime = Buffer.from(req.body.toString('utf8'), 'base64').toString('binary');
    const headerBlock = mime.split('\r\n\r\n')[0];
    assert.match(headerBlock, /From: "Random Device" <fake@outlook\.example>\r\n/);
    assert.match(headerBlock, /Reply-To: random@lan\.local\r\n/);

    await store.mutate((s) => {
        s.settings.senderAddresses = [];
    });
});

test('an alias listed in bridge settings but not actually enabled on the Microsoft account is rejected by Graph and dead-lettered (send_as_denied, finally exercised)', async () => {
    fg.setMode('success');
    fg.setEnforceFrom(true);
    fg.setAliases([]); // deliberately NOT enabled on the fake account, unlike the bridge's own settings below
    await store.mutate((s) => {
        s.settings.senderAddresses = [{ address: 'notreally@outlook.example', displayName: null }];
    });
    const deadBefore = store.state.counters.dead;

    const t = transporter();
    const info = await t.sendMail({ from: 'notreally@outlook.example', to: 'visible@example.com', subject: 'unverified alias test', text: 'hi\n' });
    assert.match(info.response, /^250/); // accepted at SMTP; the rejection is Graph-side

    const wentDead = await waitUntil(() => store.state.counters.dead > deadBefore);
    assert.ok(wentDead, 'expected Graph rejecting an address the bridge believed was a valid alias to dead-letter the message');

    fg.setEnforceFrom(false);
    await store.mutate((s) => {
        s.settings.senderAddresses = [];
    });
});

test('aliasForceFrom: a mailbox that does not honor the PATCH still delivers (from primary, not dead-lettered), records aliasFromSupported=false, and the next message skips straight to the single-call path', async () => {
    fg.setMode('success');
    fg.setEnforceFrom(true);
    fg.setAliases(['scans@outlook.example']);
    fg.setHonorPatchFrom(false);
    await store.mutate((s) => {
        s.settings.senderAddresses = [{ address: 'scans@outlook.example', displayName: null }];
        s.settings.aliasForceFrom = true;
        s.oauth.grantedScope = 'offline_access Mail.Send Mail.ReadWrite User.Read';
        s.oauth.aliasFromSupported = null;
    });

    const sentBefore = store.state.counters.sent;
    const deadBefore = store.state.counters.dead;
    const draftPostsBefore = fg.requests.filter((r) => r.url.endsWith('/me/messages') && r.method === 'POST').length;

    const t = transporter();
    const info = await t.sendMail({ from: 'scans@outlook.example', to: 'visible@example.com', subject: 'degraded alias test', text: 'hi\n' });
    assert.match(info.response, /^250/);

    const delivered = await waitUntil(() => store.state.counters.sent > sentBefore);
    assert.ok(delivered, 'a degraded alias must still be delivered, not dead-lettered');
    assert.equal(store.state.counters.dead, deadBefore, 'no dead-letter should result from a degraded (not rejected) alias');
    assert.equal(store.state.oauth.aliasFromSupported, false);

    const draftPostsAfterFirst = fg.requests.filter((r) => r.url.endsWith('/me/messages') && r.method === 'POST').length;
    assert.equal(draftPostsAfterFirst, draftPostsBefore + 1, 'expected exactly one draft created for the first (probing) message');

    const sentBeforeSecond = store.state.counters.sent;
    const info2 = await t.sendMail({ from: 'scans@outlook.example', to: 'visible@example.com', subject: 'degraded alias test 2', text: 'hi\n' });
    assert.match(info2.response, /^250/);
    const delivered2 = await waitUntil(() => store.state.counters.sent > sentBeforeSecond);
    assert.ok(delivered2);

    const draftPostsAfterSecond = fg.requests.filter((r) => r.url.endsWith('/me/messages') && r.method === 'POST').length;
    assert.equal(draftPostsAfterSecond, draftPostsAfterFirst, 'a mailbox already known not to honor the alias must not pay for three round trips again');

    fg.setEnforceFrom(false);
    fg.setAliases([]);
    fg.setHonorPatchFrom(true);
    await store.mutate((s) => {
        s.settings.senderAddresses = [];
        s.settings.aliasForceFrom = false;
        s.oauth.aliasFromSupported = null;
    });
});
