import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
    config,
    SCRYPT,
    CREDENTIAL_ALPHABET,
    DEAD_LETTER_CAP,
    DEFAULT_RATE_LIMIT_PER_MIN,
    DEFAULT_RATE_LIMIT_PER_DAY,
    DEFAULT_MAX_QUEUE_DEPTH,
    DEFAULT_QUEUE_MAX_AGE_HOURS,
} from './config.js';

const SCHEMA_VERSION = 1;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ID_RE = /^[0-9A-Z]{26}$/;

// ---------------------------------------------------------------------------
// IDs — ULID-shaped: 10 chars of ms timestamp + 16 chars of randomness, both
// base32 (Crockford). Lexical sort order matches arrival order, and the
// fixed shape lets every path built from an id be validated with ID_RE
// before touching the filesystem.
// ---------------------------------------------------------------------------

function encodeTime(ms, len) {
    let out = '';
    for (let i = len - 1; i >= 0; i--) {
        out = CROCKFORD[ms % 32] + out;
        ms = Math.floor(ms / 32);
    }
    return out;
}

function encodeRandom(len) {
    const bytes = crypto.randomBytes(len); // 256 % 32 === 0, so byte % 32 is unbiased
    let out = '';
    for (let i = 0; i < len; i++) out += CROCKFORD[bytes[i] % 32];
    return out;
}

export function generateId() {
    return encodeTime(Date.now(), 10) + encodeRandom(16);
}

export function isValidId(id) {
    return typeof id === 'string' && ID_RE.test(id);
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export function generateCredential(length = 24) {
    let out = '';
    for (let i = 0; i < length; i++) {
        out += CREDENTIAL_ALPHABET[crypto.randomInt(0, CREDENTIAL_ALPHABET.length)];
    }
    return out;
}

export function generateSecret(bytes = 32) {
    return crypto.randomBytes(bytes).toString('hex');
}

export function hashPassword(plain) {
    const salt = crypto.randomBytes(32);
    const hash = crypto.scryptSync(plain, salt, SCRYPT.keyLen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
    return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(plain, stored) {
    if (typeof stored !== 'string') return false;
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(plain, salt, expected.length, { N: Number(N), r: Number(r), p: Number(p) });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// Atomic file writes: tmp -> fsync -> rename -> best-effort directory fsync.
// A fixed .tmp suffix means a crash mid-write leaves exactly one stale file,
// overwritten on the next write, instead of accumulating litter.
// ---------------------------------------------------------------------------

async function atomicWrite(filePath, data, mode = 0o600) {
    const tmp = filePath + '.tmp';
    const fh = await fsp.open(tmp, 'w', mode);
    try {
        await fh.writeFile(data);
        await fh.sync();
    } finally {
        await fh.close();
    }
    await fsp.rename(tmp, filePath);

    // Best-effort: fsync the containing directory so the rename survives a
    // power loss. Not supported the same way on every platform (e.g.
    // Windows), so failures here are swallowed rather than fatal.
    try {
        const dh = await fsp.open(path.dirname(filePath), 'r');
        try {
            await dh.sync();
        } finally {
            await dh.close();
        }
    } catch {
        /* best-effort only */
    }
}

// Serializes all state.json writes through a promise chain. The process is
// single-threaded but writes are async, so interleaving is otherwise
// trivially possible.
let writeChain = Promise.resolve();
function serialize(fn) {
    const run = writeChain.then(fn, fn);
    writeChain = run.then(
        () => {},
        () => {}
    );
    return run;
}

// ---------------------------------------------------------------------------
// /data preflight
// ---------------------------------------------------------------------------

export async function preflight() {
    await fsp.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
    await fsp.mkdir(config.spoolDir, { recursive: true, mode: 0o700 });
    await fsp.mkdir(config.deadDir, { recursive: true, mode: 0o700 });

    const testFile = path.join(config.dataDir, '.writetest');
    try {
        await fsp.writeFile(testFile, '');
        await fsp.unlink(testFile);
    } catch (err) {
        if (err.code === 'EACCES' || err.code === 'EPERM') {
            throw new Error(
                `${config.dataDir} is not writable by this process (uid ${process.getuid ? process.getuid() : '?'}). ` +
                    `If you bind-mounted a host directory, run: sudo chown -R 1000:1000 <your-dir>. ` +
                    `A named Docker volume (the compose default) avoids this entirely.`
            );
        }
        throw err;
    }
}

// ---------------------------------------------------------------------------
// state.json
// ---------------------------------------------------------------------------

function defaultState() {
    const webPassword = generateCredential(24);
    const smtpPassword = generateCredential(24);
    return {
        state: {
            schemaVersion: SCHEMA_VERSION,
            instanceId: generateId(),
            createdAt: new Date().toISOString(),
            web: {
                passwordHash: hashPassword(webPassword),
                sessionSecret: generateSecret(32),
                passwordIsGenerated: true,
            },
            smtp: {
                username: 'bridge',
                password: smtpPassword,
            },
            oauth: {
                clientId: config.oauth.clientId,
                refreshToken: null,
                scope: config.oauth.scope,
                account: null,
                connectedAt: null,
                status: 'unconfigured', // unconfigured | connecting | connected | needs_reauth
                lastError: null,
            },
            settings: {
                fromRewrite: true,
                rateLimitPerMin: DEFAULT_RATE_LIMIT_PER_MIN,
                rateLimitPerDay: DEFAULT_RATE_LIMIT_PER_DAY,
                maxQueueDepth: DEFAULT_MAX_QUEUE_DEPTH,
                queueMaxAgeHours: DEFAULT_QUEUE_MAX_AGE_HOURS,
                // Takes effect on next boot only — the SMTP listener's
                // TLS/STARTTLS wiring is set up once at construction time.
                requireTls: false,
            },
            counters: { sent: 0, failed: 0, dead: 0 },
        },
        generated: { webPassword, smtpPassword },
    };
}

class Store {
    constructor() {
        this.state = null;
    }

    async load() {
        let raw;
        try {
            raw = await fsp.readFile(config.statePath, 'utf8');
        } catch (err) {
            if (err.code === 'ENOENT') {
                const { state, generated } = defaultState();
                this.state = state;
                await this.persist();
                return { firstRun: true, generated };
            }
            throw err;
        }

        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            // Never silently regenerate on a parse failure — that would look
            // like a working install with a lost mailbox link.
            throw new Error(`${config.statePath} is corrupt and could not be parsed: ${err.message}. Refusing to overwrite it automatically.`);
        }

        this.state = parsed;
        return { firstRun: false };
    }

    async persist() {
        const data = JSON.stringify(this.state, null, 2);
        await serialize(() => atomicWrite(config.statePath, data, 0o600));
    }

    async mutate(fn) {
        await fn(this.state);
        await this.persist();
        return this.state;
    }
}

export const store = new Store();

// ---------------------------------------------------------------------------
// Spool
// ---------------------------------------------------------------------------

function spoolPaths(id) {
    return {
        tmp: path.join(config.spoolDir, `${id}.eml.tmp`),
        eml: path.join(config.spoolDir, `${id}.eml`),
        json: path.join(config.spoolDir, `${id}.json`),
    };
}

function deadPaths(id) {
    return {
        eml: path.join(config.deadDir, `${id}.eml`),
        json: path.join(config.deadDir, `${id}.json`),
    };
}

export function spoolTmpPath(id) {
    return spoolPaths(id).tmp;
}

// Writes the FINAL processed MIME bytes (post mime.js) directly and
// durably to <id>.eml, and the metadata to <id>.json — both via
// atomicWrite's fsync+rename, which is what actually makes a 250 response
// honest. This is deliberately independent of spoolTmpPath: the raw bytes
// streamed there during SMTP DATA are a transient scratch copy (a plain
// WriteStream gives no fsync guarantee before 'finish'), read back and
// unlinked by the caller once mime.js has produced the bytes to store here.
export async function finalizeSpoolMessage(id, mimeBuffer, meta) {
    const { eml, json } = spoolPaths(id);
    await atomicWrite(eml, mimeBuffer, 0o600);
    await atomicWrite(json, JSON.stringify(meta, null, 2), 0o600);
}

export async function readSpoolMeta(id) {
    const raw = await fsp.readFile(spoolPaths(id).json, 'utf8');
    return JSON.parse(raw);
}

export async function readSpoolEml(id) {
    return fsp.readFile(spoolPaths(id).eml);
}

export async function writeSpoolMeta(id, meta) {
    await atomicWrite(spoolPaths(id).json, JSON.stringify(meta, null, 2), 0o600);
}

export async function deleteSpoolMessage(id) {
    const { eml, json } = spoolPaths(id);
    await Promise.allSettled([fsp.unlink(eml), fsp.unlink(json)]);
}

export async function moveToDead(id, meta) {
    const src = spoolPaths(id);
    const dst = deadPaths(id);
    await fsp.rename(src.eml, dst.eml);
    await atomicWrite(dst.json, JSON.stringify(meta, null, 2), 0o600);

    await pruneDeadLetters();
}

async function pruneDeadLetters() {
    const entries = await listDeadLetters();
    if (entries.length <= DEAD_LETTER_CAP) return;
    entries.sort((a, b) => a.receivedAt - b.receivedAt);
    const toRemove = entries.slice(0, entries.length - DEAD_LETTER_CAP);
    for (const entry of toRemove) {
        await Promise.allSettled([fsp.unlink(deadPaths(entry.id).eml), fsp.unlink(deadPaths(entry.id).json)]);
    }
}

export async function readDeadMeta(id) {
    const raw = await fsp.readFile(deadPaths(id).json, 'utf8');
    return JSON.parse(raw);
}

// Reverse of moveToDead — used by the GUI's dead-letter "Retry" action. The
// caller is responsible for resetting attempts/nextAttemptAt/lastError via
// writeSpoolMeta immediately after.
export async function moveDeadToSpool(id) {
    const src = deadPaths(id);
    const dst = spoolPaths(id);
    await fsp.rename(src.eml, dst.eml);
    await fsp.rename(src.json, dst.json);
}

export async function deleteDeadLetter(id) {
    const { eml, json } = deadPaths(id);
    await Promise.allSettled([fsp.unlink(eml), fsp.unlink(json)]);
}

export async function readDeadEml(id) {
    return fsp.readFile(deadPaths(id).eml);
}

// Scans spool/*.json into memory, sorted by nextAttemptAt. Cleans up
// orphans: a .eml with no .json (crash between the two writes) is deleted;
// a .json with no .eml is dead-lettered as spool_corrupt.
export async function listSpoolMessages() {
    const names = await fsp.readdir(config.spoolDir).catch(() => []);
    const jsonIds = new Set();
    const emlIds = new Set();
    for (const name of names) {
        if (name.endsWith('.json')) jsonIds.add(name.slice(0, -'.json'.length));
        else if (name.endsWith('.eml')) emlIds.add(name.slice(0, -'.eml'.length));
    }

    const messages = [];
    for (const id of jsonIds) {
        if (!emlIds.has(id)) {
            await fsp.unlink(spoolPaths(id).json).catch(() => {});
            continue;
        }
        try {
            messages.push(await readSpoolMeta(id));
        } catch {
            // corrupt metadata — treat like a missing pair, drop it
            await Promise.allSettled([fsp.unlink(spoolPaths(id).eml), fsp.unlink(spoolPaths(id).json)]);
        }
    }
    for (const id of emlIds) {
        if (!jsonIds.has(id)) await fsp.unlink(spoolPaths(id).eml).catch(() => {});
    }

    messages.sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);
    return messages;
}

export async function listDeadLetters() {
    const names = await fsp.readdir(config.deadDir).catch(() => []);
    const out = [];
    for (const name of names) {
        if (!name.endsWith('.json')) continue;
        try {
            out.push(JSON.parse(await fsp.readFile(path.join(config.deadDir, name), 'utf8')));
        } catch {
            /* ignore corrupt dead-letter metadata */
        }
    }
    return out;
}

export function spoolTmpFileHandle(id, mode = 0o600) {
    return fs.createWriteStream(spoolTmpPath(id), { mode, flags: 'wx' });
}
