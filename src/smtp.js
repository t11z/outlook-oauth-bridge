import { SMTPServer } from 'smtp-server';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { config, MAX_MESSAGE_BYTES, MAX_RECIPIENTS, SMTP_BANNER } from './config.js';
import { store, generateId, spoolTmpPath, spoolTmpFileHandle, finalizeSpoolMessage } from './store.js';
import { events } from './events.js';
import { queue } from './queue.js';
import { processOutgoingMessage } from './mime.js';

// Per-remote-IP auth failure tracking: 10 failures in 5 minutes bans that
// IP for 15 minutes. Without this, a printer with a stale saved password
// would otherwise retry forever with no visible signal to the user beyond
// the live feed.
const AUTH_FAIL_THRESHOLD = 10;
const AUTH_FAIL_WINDOW_MS = 5 * 60_000;
const AUTH_BAN_MS = 15 * 60_000;
const authFailures = new Map(); // ip -> { count, windowStart, bannedUntil }

function timingSafeEqualStr(a, b) {
    const ah = crypto.createHash('sha256').update(String(a)).digest();
    const bh = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ah, bh);
}

function isBanned(ip) {
    const rec = authFailures.get(ip);
    return !!(rec && rec.bannedUntil && rec.bannedUntil > Date.now());
}

function recordAuthFailure(ip) {
    const now = Date.now();
    let rec = authFailures.get(ip);
    if (!rec || now - rec.windowStart > AUTH_FAIL_WINDOW_MS) rec = { count: 0, windowStart: now, bannedUntil: 0 };
    rec.count++;
    if (rec.count >= AUTH_FAIL_THRESHOLD) rec.bannedUntil = now + AUTH_BAN_MS;
    authFailures.set(ip, rec);
}

function recordAuthSuccess(ip) {
    authFailures.delete(ip);
}

function onConnect(session, callback) {
    if (isBanned(session.remoteAddress)) {
        const err = new Error('Too many failed authentication attempts, try again later');
        err.responseCode = 421;
        return callback(err);
    }
    callback();
}

function onAuth(auth, session, callback) {
    const { username, password } = store.state.smtp;
    const ok = timingSafeEqualStr(auth.username, username) && timingSafeEqualStr(auth.password, password);

    if (ok) {
        recordAuthSuccess(session.remoteAddress);
        return callback(null, { user: auth.username });
    }

    recordAuthFailure(session.remoteAddress);
    events.emitEvent('auth-failure', { ip: session.remoteAddress, username: auth.username });
    const err = new Error('Authentication credentials invalid');
    err.responseCode = 535;
    callback(err);
}

function onMailFrom(address, session, callback) {
    // Never connected: queueing mail for an account that has never existed
    // is a footgun — reject early. Previously connected but now
    // needs_reauth: accept and queue, so a later reconnect flushes it.
    if (store.state.oauth.status === 'unconfigured') {
        const err = new Error('Bridge is not linked to an Outlook account yet');
        err.responseCode = 451;
        return callback(err);
    }

    if (queue.status().depth >= store.state.settings.maxQueueDepth) {
        const err = new Error('Insufficient system storage');
        err.responseCode = 452;
        return callback(err);
    }

    session.envelopeFrom = address.address;
    session.envelopeTo = [];
    callback();
}

function onRcptTo(address, session, callback) {
    if (!address.address || !address.address.includes('@')) {
        const err = new Error('Invalid recipient address');
        err.responseCode = 553;
        return callback(err);
    }
    if (session.envelopeTo.length >= MAX_RECIPIENTS) {
        const err = new Error('Too many recipients');
        err.responseCode = 452;
        return callback(err);
    }
    session.envelopeTo.push(address.address);
    callback();
}

// Shared by SMTP ingress (onData, below) and the GUI's "send test mail"
// endpoint (web/api.js): mime.js processing happens exactly once, here, at
// receive time — never again on retry. That's what makes a "message queued"
// response an honest promise: what gets accepted is exactly what gets sent,
// even if the account or settings change before the queue gets to it later.
// Throws Error with `.reason` ('no_recipients') on the one rejectable case;
// callers translate that into their own protocol (SMTP 554 vs HTTP 4xx).
export async function spoolProcessedMessage({ raw, envelopeFrom, envelopeTo, id = generateId() }) {
    const account = store.state.oauth.account;
    const { mime, meta } = processOutgoingMessage(raw, {
        envelopeTo,
        accountAddress: account?.address,
        fromRewrite: store.state.settings.fromRewrite,
        bridgeId: id,
    });

    if (meta.reconcile.totalRecipients === 0) {
        const err = new Error('No deliverable recipients');
        err.reason = 'no_recipients';
        throw err;
    }

    const messageMeta = {
        id,
        receivedAt: Date.now(),
        size: mime.length,
        envelopeFrom,
        envelopeTo,
        headerFrom: meta.headerFrom,
        subject: meta.subject,
        state: 'queued',
        attempts: 0,
        nextAttemptAt: Date.now(),
        lastError: null,
        reconcile: meta.reconcile,
    };

    await finalizeSpoolMessage(id, mime, messageMeta);

    events.emitEvent('queued', { id, subject: messageMeta.subject, size: messageMeta.size, reconcile: messageMeta.reconcile });
    await queue.notify(messageMeta);

    return messageMeta;
}

// smtp-server enforces the MAIL FROM SIZE= declaration itself (against the
// `size` option below) — the check that's ours to make is here, against
// stream.sizeExceeded/byteLength, which update live as DATA streams in.
async function onData(stream, session, callback) {
    const id = generateId();
    const tmpPath = spoolTmpPath(id);
    const writeStream = spoolTmpFileHandle(id);
    let writeError = null;
    writeStream.on('error', (err) => {
        writeError = err;
    });
    stream.pipe(writeStream);

    // Every path below runs only after the stream has been fully drained —
    // rejecting mid-stream desyncs smtp-server's command channel and
    // produces symptoms that look nothing like the actual error.
    stream.on('end', async () => {
        const fail = (message, responseCode) => {
            const err = new Error(message);
            err.responseCode = responseCode;
            return fsp
                .unlink(tmpPath)
                .catch(() => {})
                .then(() => callback(err));
        };

        if (stream.sizeExceeded) {
            return fail('Message size exceeds fixed maximum message size', 552);
        }
        if (writeError) {
            return fail('Could not write message to spool', 451);
        }

        await new Promise((resolve) => writeStream.end(resolve));

        let raw;
        try {
            raw = await fsp.readFile(tmpPath);
        } catch {
            return fail('Could not read spooled message', 451);
        }

        let messageMeta;
        try {
            messageMeta = await spoolProcessedMessage({ raw, envelopeFrom: session.envelopeFrom, envelopeTo: session.envelopeTo, id });
        } catch (err) {
            if (err.reason === 'no_recipients') return fail('No deliverable recipients', 554);
            return fail('Could not finalize spooled message', 451);
        }
        await fsp.unlink(tmpPath).catch(() => {});

        callback(null, `Message queued as ${messageMeta.id}`);
    });
}

let server = null;

export function createSmtpServer() {
    const requireTls = store.state.settings.requireTls;

    if (requireTls && !(config.tlsKeyPath && config.tlsCertPath)) {
        // Fail fast rather than silently falling back to smtp-server's
        // bundled self-signed cert — that fallback is the exact "worse
        // than no TLS" outcome requireTls exists to avoid (see config.js).
        throw new Error(
            'settings.requireTls is enabled but BRIDGE_TLS_KEY/BRIDGE_TLS_CERT are not set. ' +
                'Provide both as real certificate files, or disable "Require TLS" in the GUI settings.'
        );
    }

    const tls = requireTls ? { key: fs.readFileSync(config.tlsKeyPath), cert: fs.readFileSync(config.tlsCertPath) } : {};

    return new SMTPServer({
        name: SMTP_BANNER,
        banner: `${SMTP_BANNER} ready`,
        secure: false,
        authMethods: ['PLAIN', 'LOGIN'],
        authOptional: false, // design invariant — there is no configuration path that disables auth
        allowInsecureAuth: !requireTls,
        disabledCommands: requireTls ? [] : ['STARTTLS'],
        hideSTARTTLS: !requireTls,
        ...tls,
        size: MAX_MESSAGE_BYTES,
        maxClients: 20,
        socketTimeout: 60_000,
        logger: false,
        onConnect,
        onAuth,
        onMailFrom,
        onRcptTo,
        onData,
    });
}

// settings.smtpPort is seeded from BRIDGE_SMTP_PORT on first run and is
// authoritative after that (see store.js's defaultState) — falls back to
// config.smtpPort only for a state.json written before this setting existed.
export function configuredPort() {
    return store.state.settings.smtpPort || config.smtpPort;
}

// Async because listen() failures (e.g. EACCES on a privileged port like 587
// without root/CAP_NET_BIND_SERVICE) surface asynchronously via the server's
// 'error' event, not as a synchronous throw — this turns that into a
// rejected promise so it reaches bootstrap().catch() in index.js with a
// clear, actionable message instead of an uncaught-exception stack trace.
export function start() {
    if (server) return Promise.resolve(server);
    const port = configuredPort();
    const instance = createSmtpServer();
    server = instance;
    return new Promise((resolve, reject) => {
        function onBindError(err) {
            server = null;
            if (err.code === 'EACCES') {
                reject(
                    new Error(
                        `Cannot bind SMTP port ${port}: permission denied. Ports below 1024 (like 587) need root or the ` +
                            `CAP_NET_BIND_SERVICE capability inside the container — this image runs as a non-root user by ` +
                            `design (see the README's "Privileged ports" section). Pick 2525 in the GUI's Settings instead, ` +
                            `or grant the capability yourself if you need 587.`
                    )
                );
                return;
            }
            reject(err);
        }
        instance.once('error', onBindError);
        instance.listen(port, config.bind, () => {
            // Only meant to catch a pre-listen bind failure — detach it once
            // past that window so a later fault (e.g. during stop()'s
            // close()) falls through to Node's default unhandled-'error'
            // crash instead of rejecting an already-settled promise, same as
            // before this function had any 'error' handling at all. Docker's
            // `restart: unless-stopped` depends on that crash, not a silent
            // half-dead listener.
            instance.removeListener('error', onBindError);
            events.emitEvent('smtp-listening', { port, bind: config.bind });
            resolve(instance);
        });
    });
}

export function stop() {
    return new Promise((resolve) => {
        if (!server) return resolve();
        server.close(() => {
            server = null;
            resolve();
        });
    });
}
