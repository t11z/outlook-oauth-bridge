// Covers the GUI "Restart bridge" button end to end: POST /api/system/restart
// must respond before the process tears anything down, and the process must
// then actually exit(0) so a supervisor (Docker's restart: unless-stopped,
// systemd, ...) brings it back up with the new settings applied.
//
// This has to spawn a real child process rather than dynamic-importing
// src/index.js in-process like the other test files do: the handler under
// test calls process.exit(0), which would kill the test runner itself if it
// ran in this process. process.exit() is a direct syscall from the process
// itself, not a delivered signal, so — unlike the SIGTERM-to-a-child-process
// caveat in the README — this is expected to behave the same on Windows and
// Linux.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HTTP_PORT = 8499;
const SMTP_PORT = 25499;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const INDEX_JS = fileURLToPath(new URL('../src/index.js', import.meta.url));

let dataDir;
let child;

function cookieFrom(res) {
    const setCookie = res.headers.get('set-cookie');
    return setCookie ? setCookie.split(';')[0] : null;
}

async function waitForHealthz(deadlineMs = 10_000) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${BASE}/healthz`);
            if (res.ok) return;
        } catch {
            /* not listening yet */
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('bridge did not become healthy in time');
}

function waitForExit(proc, deadlineMs = 10_000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('process did not exit in time')), deadlineMs);
        proc.once('exit', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal });
        });
    });
}

after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
        child.kill();
    }
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

test('POST /api/system/restart responds 202 before the process tears down, then the process actually exits(0)', async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oob-restart-'));

    let stdout = '';
    child = spawn(process.execPath, [INDEX_JS], {
        env: {
            ...process.env,
            BRIDGE_DATA_DIR: dataDir,
            BRIDGE_HTTP_PORT: String(HTTP_PORT),
            BRIDGE_SMTP_PORT: String(SMTP_PORT),
            BRIDGE_BIND: '127.0.0.1',
            BRIDGE_CLIENT_ID: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
    });

    await waitForHealthz();

    // Parse the generated web GUI password out of the first-run banner
    // (the format printFirstRunBanner writes) — there's no other way to log
    // in to a freshly bootstrapped instance.
    const match = stdout.match(/Web GUI[^\n]*\n[^\n]*Password:\s*(\S+)/);
    assert.ok(match, `expected to find the web GUI password in the first-run banner, got:\n${stdout}`);
    const webPassword = match[1];

    const loginRes = await fetch(`${BASE}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: webPassword }),
    });
    assert.equal(loginRes.status, 200);
    const cookie = cookieFrom(loginRes);
    const { csrfToken } = await loginRes.json();

    const restartRes = await fetch(`${BASE}/api/system/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({}),
    });
    // Getting a real 202 back at all proves the response was flushed before
    // the server started closing connections.
    assert.equal(restartRes.status, 202);
    const restartBody = await restartRes.json();
    assert.deepEqual(restartBody, { ok: true });

    const { code, signal } = await waitForExit(child);
    assert.equal(signal, null, 'expected a clean exit, not a killing signal');
    assert.equal(code, 0, 'expected exit code 0 so restart: unless-stopped treats this as a normal restart, not a crash loop');
});
