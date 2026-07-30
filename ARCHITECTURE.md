# Architecture

Design rationale and non-obvious constraints for `outlook-oauth-bridge`. Read `README.md` first for what the product does; this file is for anyone (human or AI) about to modify the code.

## Layout

```
src/
├── index.js    Bootstrap: preflight, first-run banner, wires smtp+queue+web, SIGTERM
├── config.js   Env parsing + fixed constants (MAX_MESSAGE_BYTES, backoff table, etc.)
├── store.js    All filesystem I/O: state.json, spool, credentials, atomic writes — the trust anchor
├── events.js   In-process event bus + ring buffer (SSE feed) + stdout structured logging
├── mime.js     Pure functions: header parsing, From rewrite, envelope/header recipient reconciliation
├── smtp.js     smtp-server wiring: auth, size gate, spool-then-accept
├── oauth.js    Device code flow, token cache/refresh, single-flight, invalid_grant recovery
├── graph.js    sendMail POST + error classification (permanent/retryable/retryable-ambiguous/rate-limited/auth)
├── queue.js    Spool-is-the-queue: serial worker, backoff+jitter, dead-letter, injectable clock
└── web/
    ├── server.js   Router + static file serving (fixed 3-file allowlist)
    ├── session.js  HMAC-signed cookies (key derives from password hash), login throttling
    └── api.js      JSON endpoints + SSE
public/         index.html, app.js, style.css — no framework, no bundler
test/
├── fake-graph.js   Mocks login.microsoftonline.com + graph.microsoft.com
├── mime.test.js    Unit tests for mime.js's pure functions
└── e2e.test.js     Real SMTPServer + real web server + real queue, against the fake Graph
```

## Why the pieces are shaped this way

**mime.js processes each message exactly once, at receive time (in `smtp.spoolProcessedMessage`), not on every retry.** The `.eml` file on disk is already the Graph-ready payload — From rewritten, recipients reconciled, CRLF-normalized. This makes the SMTP `250` response an honest promise: what gets accepted is exactly what gets sent, even if the account or settings change before the queue gets to it later. Don't move mime processing into `queue.js` — it would make delivery non-deterministic relative to what was accepted.

**graph.js's `sendMail()` never throws.** It always resolves to `{ ok, class, code, message, retryAfterMs? }`. `queue.js` and `smtp.js`'s test-mail path both depend on this — a throwing `sendMail()` would need try/catch at every call site instead of one classification switch in `queue.js`'s `applyResult()`.

**queue.js's pause gate checks `oauth.status !== 'connected'` (positive), not an enumeration of bad statuses.** It used to check only `=== 'needs_reauth'`, which left a real gap: a message queued while `unconfigured` (e.g. the user disconnects with mail still queued) hit `graph.sendMail()`'s `class: 'auth'` result repeatedly with no backoff — a busy loop. The positive check closes that gap and any similar one that might appear if a new status value is ever added.

**`realClock.sleep(ms, signal)` in queue.js takes an `AbortSignal`.** `wake()` (used on stop, on reconnect, on manual "retry now") resolves the pending wait *promise* immediately, but without signal-based cancellation the underlying `setTimeout` — up to a 60s backoff wait — keeps running and keeps the process alive until it fires on its own. This stalled graceful shutdown and hung the e2e test suite until it was fixed; don't reintroduce a bare `setTimeout` here.

**`events.emitEvent(type, data)` merges `data` after its own `{ seq, type, at }`.** Do not rename the ring-buffer sequence field back to `id` — several event types (`queued`/`sending`/`sent`/`retry`/`dead`) pass their own semantic `id` (the spool message id) in `data`, and a caller-less event (like `auth`) would silently fall back to displaying the raw sequence number instead of nothing. This exact bug shipped once; the frontend's `pushFeedRow`/`feedMessage` in `public/app.js` depend on `seq` and `id` staying distinct.

**Settings split between fixed constants and live-editable state.** `MAX_MESSAGE_BYTES`, `MAX_RECIPIENTS`, the backoff table, and attempt caps are fixed in `config.js` — they're tied to Graph's actual API limits or aren't meaningful user preferences. `fromRewrite`, `rateLimitPerMin/Day`, `maxQueueDepth`, `queueMaxAgeHours` live in `state.json.settings` and are read fresh from `store.state.settings` on every check in `queue.js` — no restart needed. `requireTls` is the one exception: it's stored in `settings` (so the GUI can edit it) but only takes effect on next boot, since it affects `smtp-server`'s construction-time TLS wiring.

**Web layer never spreads `store.state`.** `web/api.js`'s `projectState()` names every field explicitly. `state.json` holds `web.passwordHash`, `web.sessionSecret`, and `oauth.refreshToken` — any of those reaching the browser is a real credential leak, not a cosmetic bug. If you add a field to `state.json`, it does *not* automatically become visible to the GUI, and that's intentional — add it to `projectState()` explicitly if it should be.

**Session cookie key derives from the password hash**, not a stored session table: `HMAC(sessionSecret, passwordHash)`. Changing the password invalidates every existing session as a side effect, with no revocation list to maintain. `handlePasswordChange` issues a fresh cookie for the caller's own request afterward — otherwise the user who just changed their password would be logged out by their own action.

**Device code flow is fire-and-forget from the API's perspective.** `oauth.beginDeviceCodeFlow()` returns as soon as Microsoft issues a code (one fast HTTP round trip) and runs the polling loop (up to ~15 min) in the background; it does not block the HTTP request. Progress is pushed over SSE (`auth` events) and mirrored in `oauth.pendingDeviceCode()`. Don't `await` the old blocking pattern back in — `POST /api/oauth/device/start` needs to return in well under a second.

**The OAuth client ID has two sources, and only one of them is correct to read from `oauth.js`.** `config.oauth.clientId` comes from `BRIDGE_CLIENT_ID`, read once at process start. `state.oauth.clientId` is what the GUI writes (`POST /api/oauth/client` → `oauth.setClientId`), seeded from `config.oauth.clientId` only on first run. Always go through `oauth.currentClientId()` (state first, config as fallback) — never read `config.oauth.clientId` directly in a request builder. `tokenParams()` used to do exactly that, so every token request was built from the env value while the GUI silently wrote somewhere else; with `BRIDGE_CLIENT_ID` unset (the normal case for anyone using the GUI), the request went out with an empty `client_id` and Microsoft rejected it with AADSTS900144. The device-start gate in `web/api.js` and `projectState()`'s exposed `clientId` field must use the same accessor as the request builder, or the gate and the actual request can disagree again.

## Testing

`test/fake-graph.js` mocks both Microsoft endpoints behind one `http.Server`, controllable via `setMode()` (`success`, `invalid_base64`, `send_as_denied`, `too_large`, `unauthorized`, `server_error`, `quota`, `rate_limited`, `hang`, `reset`, `invalid_grant`) and `setDevicePendingCount()`. It's picked up by `node --test`'s file discovery (any `.js` under a `test/` directory) but contributes zero assertions itself — that's expected, not a bug.

When testing timing-sensitive queue behavior manually, inject a fake clock via `createQueue({ clock })` where `clock.sleep(ms)` resolves quickly while still advancing a virtual `now()` — a clock whose `sleep()` is fast but whose `now()` stays real will make backoff waits busy-poll instead of accelerating, since `queue.js`'s age/backoff math is computed from real deltas.

## Known platform gaps

Real `SIGTERM` delivery cannot be exercised on Windows dev machines (Windows has no POSIX signals; `child.kill('SIGTERM')` hard-terminates instead of invoking the handler). `SIGINT` is emulated on Windows and exercises the same `shutdown()` path, but even that has been unreliable against piped child processes in testing here. Verify graceful shutdown manually against the real Linux container before relying on it.
