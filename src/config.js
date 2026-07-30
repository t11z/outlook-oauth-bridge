import path from 'node:path';

// Loads .env into process.env if present (Node's built-in loader, no
// dependency needed). In the container, env vars normally come from
// docker-compose's `environment:` block instead, so a missing .env is fine.
try {
    process.loadEnvFile();
} catch {
    /* no .env file — env vars may already be set another way */
}

function bool(value, fallback) {
    if (value === undefined) return fallback;
    return value === '1' || value.toLowerCase() === 'true';
}

function int(value, fallback) {
    if (value === undefined) return fallback;
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
}

const dataDir = process.env.BRIDGE_DATA_DIR || '/data';

export const config = {
    dataDir,
    statePath: path.join(dataDir, 'state.json'),
    spoolDir: path.join(dataDir, 'spool'),
    deadDir: path.join(dataDir, 'spool', 'dead'),

    smtpPort: int(process.env.BRIDGE_SMTP_PORT, 2525),
    httpPort: int(process.env.BRIDGE_HTTP_PORT, 8080),
    bind: process.env.BRIDGE_BIND || '0.0.0.0',
    trustTls: bool(process.env.BRIDGE_TRUST_TLS, false),
    resetPassword: bool(process.env.BRIDGE_RESET_PASSWORD, false),
    logLevel: process.env.BRIDGE_LOG_LEVEL || 'info',

    // Real certs for the SMTP STARTTLS listener. Without these, requireTls
    // would fall back to smtp-server's bundled self-signed cert — worse
    // than no TLS, since it breaks a meaningful fraction of legacy devices'
    // certificate validation instead of just running in cleartext.
    tlsKeyPath: process.env.BRIDGE_TLS_KEY || '',
    tlsCertPath: process.env.BRIDGE_TLS_CERT || '',

    oauth: {
        clientId: process.env.BRIDGE_CLIENT_ID || '',
        clientSecret: process.env.BRIDGE_CLIENT_SECRET || '',
        graphBase: process.env.BRIDGE_GRAPH_BASE || 'https://graph.microsoft.com/v1.0',
        loginBase: process.env.BRIDGE_LOGIN_BASE || 'https://login.microsoftonline.com/consumers/oauth2/v2.0',
        scope: 'offline_access Mail.Send User.Read',
    },
};

// SMTP message size limit. Graph's sendMail (MIME mode) caps the base64
// request body at 4 MiB; base64 expands by 4/3, so the raw MIME budget is
// 4 MiB * 3/4 = 3,145,728 bytes. Round down for margin and announce this via
// SMTP SIZE so clients don't send messages that will always 413.
// Fixed by the Graph API itself — not user-tunable, so not part of
// state.json's editable settings.
export const MAX_MESSAGE_BYTES = 3_000_000;
export const MAX_RECIPIENTS = 50;
export const DEAD_LETTER_CAP = 100;
export const SMTP_BANNER = 'outlook-oauth-bridge';

// Defaults for the live-editable counterparts in state.json's `settings`
// (rateLimitPerMin, rateLimitPerDay, maxQueueDepth, queueMaxAgeHours) —
// used only to seed a fresh install; queue.js reads the current values from
// store.state.settings at runtime, not these constants.
export const DEFAULT_RATE_LIMIT_PER_MIN = 20;
export const DEFAULT_RATE_LIMIT_PER_DAY = 250;
export const DEFAULT_MAX_QUEUE_DEPTH = 500;
export const DEFAULT_QUEUE_MAX_AGE_HOURS = 72;

// Attempt N -> delay in ms before attempt N+1. Equal jitter is applied by
// the caller: base/2 + random(0, base/2).
export const BACKOFF_TABLE_MS = [30_000, 120_000, 480_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000];
export const MAX_ATTEMPTS = BACKOFF_TABLE_MS.length + 1; // 8
export const AMBIGUOUS_MAX_ATTEMPTS = 2; // transport failures that may have already been delivered

export const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 64 };
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 3600;
export const LOGIN_LOCKOUT = { threshold: 5, baseMs: 5_000, maxMs: 15 * 60_000 };

export const CREDENTIAL_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'; // no 0/O/1/I/l
