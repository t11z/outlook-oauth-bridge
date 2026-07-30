import {
    store,
    listSpoolMessages,
    writeSpoolMeta,
    deleteSpoolMessage,
    moveToDead,
    readSpoolEml,
    readDeadMeta,
    moveDeadToSpool,
} from './store.js';
import { events } from './events.js';
import * as graph from './graph.js';
import { BACKOFF_TABLE_MS, MAX_ATTEMPTS, AMBIGUOUS_MAX_ATTEMPTS } from './config.js';

const realClock = {
    now: () => Date.now(),
    // signal support matters here: without it, waking early (wake()) only
    // resolves the *promise* — the underlying setTimeout (up to a 60s
    // backoff wait) keeps running and keeps the process alive until it
    // fires on its own, which stalls shutdown and hangs test runs.
    sleep: (ms, signal) =>
        new Promise((resolve) => {
            const timer = setTimeout(resolve, ms);
            if (signal) {
                if (signal.aborted) {
                    clearTimeout(timer);
                    resolve();
                } else {
                    signal.addEventListener(
                        'abort',
                        () => {
                            clearTimeout(timer);
                            resolve();
                        },
                        { once: true }
                    );
                }
            }
        }),
};

// The spool directory *is* the queue — there is no separate queue object on
// disk. One serial worker, one message in flight at a time: an inbox relay
// runs single-digit messages per minute, so concurrency would only cost
// ordering, rate-limit accounting, and refresh races for no benefit.
export function createQueue({ clock = realClock } = {}) {
    let messages = []; // in-memory mirror of spool/*.json, kept roughly sorted by nextAttemptAt
    let pauseUntil = 0; // clock.now() timestamp; 0 = not paused
    let wakeAbort = null; // AbortController for the in-flight waitForWake(), if any
    let stopRequested = false;
    let loopPromise = null;
    let authListener = null;

    // Sliding-window rate limiting over actual successful sends.
    const sentTimestamps = [];

    function wake() {
        if (wakeAbort) {
            const controller = wakeAbort;
            wakeAbort = null;
            controller.abort();
        }
    }

    function waitForWake(timeoutMs) {
        const controller = new AbortController();
        wakeAbort = controller;
        return clock.sleep(timeoutMs, controller.signal).then(() => {
            if (wakeAbort === controller) wakeAbort = null;
        });
    }

    function pruneRateWindow(now) {
        while (sentTimestamps.length && now - sentTimestamps[0] > 24 * 3600_000) sentTimestamps.shift();
    }

    function isRateLimited() {
        const now = clock.now();
        pruneRateWindow(now);
        const { rateLimitPerMin, rateLimitPerDay } = store.state.settings;
        const lastMinute = sentTimestamps.filter((t) => now - t < 60_000).length;
        return lastMinute >= rateLimitPerMin || sentTimestamps.length >= rateLimitPerDay;
    }

    async function deadLetter(message, result, reason) {
        message.state = 'dead';
        message.lastError = {
            class: result?.class ?? reason,
            code: result?.code ?? reason,
            message: result?.message ?? reason,
            at: new Date(clock.now()).toISOString(),
        };
        await moveToDead(message.id, message);
        messages = messages.filter((m) => m.id !== message.id);
        await store.mutate((s) => {
            s.counters.dead++;
        });
        events.emitEvent('dead', { id: message.id, subject: message.subject, reason: message.lastError.message });
    }

    async function applyResult(message, result) {
        if (result.ok) {
            await deleteSpoolMessage(message.id);
            messages = messages.filter((m) => m.id !== message.id);
            sentTimestamps.push(clock.now());
            await store.mutate((s) => {
                s.counters.sent++;
            });
            events.emitEvent('sent', { id: message.id, subject: message.subject });
            return;
        }

        if (result.class === 'auth') {
            // oauth.js already marked needs_reauth and emitted its own event.
            // Leave the message queued untouched — the top-of-loop status
            // check will pause the worker until reconnect, then retry it.
            // Not counted as a failure: a 429/token episode can retry the
            // same message many times before delivering fine, and this
            // counter feeds the GUI health badge — it should reflect actual
            // send failures, not routine rate-limit/auth pause cycles.
            return;
        }

        if (result.class === 'rate-limited') {
            const resumeAt = clock.now() + (result.retryAfterMs ?? 60_000);
            pauseUntil = Math.max(pauseUntil, resumeAt);
            events.emitEvent('paused', { reason: 'rate_limited', resumeAt });
            return;
        }

        await store.mutate((s) => {
            s.counters.failed++;
        });

        if (result.class === 'permanent') {
            return deadLetter(message, result, 'permanent');
        }

        // retryable | retryable-ambiguous | retryable-quota
        const attempts = message.attempts + 1;
        const cap = result.class === 'retryable-ambiguous' ? AMBIGUOUS_MAX_ATTEMPTS : MAX_ATTEMPTS;
        if (attempts >= cap) {
            return deadLetter(message, result, 'max_attempts');
        }

        // Equal jitter (base/2 + random(0, base/2)) so a restart with many
        // queued messages doesn't produce a thundering herd. A quota (507)
        // error jumps straight to the longest backoff instead of escalating
        // through the table.
        const backoffIndex = result.class === 'retryable-quota' ? BACKOFF_TABLE_MS.length - 1 : Math.min(attempts - 1, BACKOFF_TABLE_MS.length - 1);
        const base = BACKOFF_TABLE_MS[backoffIndex];
        const delay = base / 2 + Math.random() * (base / 2);

        message.attempts = attempts;
        message.nextAttemptAt = clock.now() + delay;
        message.state = 'queued';
        message.lastError = { class: result.class, code: result.code, message: result.message, at: new Date(clock.now()).toISOString() };
        await writeSpoolMeta(message.id, message);
        events.emitEvent('retry', { id: message.id, attempts, nextAttemptAt: message.nextAttemptAt, reason: result.message });
    }

    // Expiry must be enforced independently of whether a send was ever
    // attempted — a message stuck behind a needs_reauth pause (or a long
    // rate-limit pause) never reaches processOne() otherwise, and could sit
    // past queueMaxAgeHours indefinitely instead of being pruned.
    async function pruneExpired(now) {
        const maxAgeMs = store.state.settings.queueMaxAgeHours * 3600_000;
        const expired = messages.filter((m) => now - m.receivedAt > maxAgeMs);
        for (const message of expired) {
            await deadLetter(message, null, 'expired_in_queue');
        }
    }

    async function processOne(message) {
        events.emitEvent('sending', { id: message.id, subject: message.subject, attempt: message.attempts + 1 });

        let eml;
        try {
            eml = await readSpoolEml(message.id);
        } catch (err) {
            return deadLetter(message, { class: 'permanent', code: 'SpoolReadError', message: err.message }, 'spool_read_error');
        }

        const result = await graph.sendMail(eml);
        await applyResult(message, result);
    }

    async function loop() {
        while (!stopRequested) {
            const now = clock.now();

            await pruneExpired(now);

            // Gate positively (only proceed once actually connected) rather
            // than naming the bad statuses one by one. A message can reach
            // the queue while not connected — e.g. the user disconnects
            // with mail still queued — and graph.sendMail() would fail
            // every such attempt with class 'auth', which applyResult()
            // deliberately does NOT advance nextAttemptAt/attempts for
            // (it's not the message's fault). Without this gate that
            // combination is a tight busy-loop, not a paused queue.
            if (store.state.oauth.status !== 'connected') {
                await waitForWake(30_000); // re-checked periodically in case a 'connected' event was missed
                continue;
            }

            if (pauseUntil > now) {
                await waitForWake(pauseUntil - now);
                continue;
            }
            if (pauseUntil) {
                pauseUntil = 0;
                events.emitEvent('resumed', {});
            }

            if (isRateLimited()) {
                await waitForWake(1000);
                continue;
            }

            const next = messages.find((m) => m.nextAttemptAt <= now);
            if (!next) {
                const upcoming = messages.reduce((min, m) => (min === null || m.nextAttemptAt < min ? m.nextAttemptAt : min), null);
                await waitForWake(upcoming !== null ? Math.min(Math.max(upcoming - now, 0), 60_000) : 60_000);
                continue;
            }

            await processOne(next);
        }
    }

    return {
        async start() {
            if (loopPromise) return;
            stopRequested = false;
            messages = await listSpoolMessages();

            // The needs_reauth branch only re-checks status every 30s; without
            // this, a reconnect would sit waiting for up to 30 real seconds
            // before the queue noticed, instead of flushing immediately.
            authListener = (e) => {
                if (e.type === 'auth' && e.status === 'connected') wake();
            };
            events.on('event', authListener);

            loopPromise = loop().catch((err) => {
                events.emitEvent('error', { message: `queue loop crashed: ${err.message}` });
            });
        },

        async stop() {
            stopRequested = true;
            wake();
            await loopPromise;
            loopPromise = null;
            if (authListener) {
                events.off('event', authListener);
                authListener = null;
            }
        },

        // Called by smtp.js right after a message is spooled (fast path,
        // avoids a full directory rescan), or with no argument to force a
        // reload from disk (GUI actions that touch the filesystem directly).
        async notify(message) {
            if (message) messages.push(message);
            else messages = await listSpoolMessages();
            wake();
        },

        async retryNow(id) {
            const message = messages.find((m) => m.id === id);
            if (!message) return false;
            message.nextAttemptAt = clock.now();
            await writeSpoolMeta(message.id, message);
            wake();
            return true;
        },

        async discard(id) {
            const existed = messages.some((m) => m.id === id);
            messages = messages.filter((m) => m.id !== id);
            await deleteSpoolMessage(id);
            return existed;
        },

        async requeueDeadLetter(id) {
            const meta = await readDeadMeta(id);
            await moveDeadToSpool(id);
            meta.state = 'queued';
            meta.attempts = 0;
            meta.nextAttemptAt = clock.now();
            meta.lastError = null;
            await writeSpoolMeta(id, meta);
            messages.push(meta);
            wake();
            return meta;
        },

        listActive() {
            return messages.map((m) => ({ ...m }));
        },

        status() {
            const now = clock.now();
            return { depth: messages.length, paused: pauseUntil > now, pauseUntil: pauseUntil || null };
        },
    };
}

export const queue = createQueue();
