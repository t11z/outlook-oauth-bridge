# outlook-oauth-bridge

A minimal SMTP relay for devices that can't do OAuth — printers, NAS boxes, home-lab scripts — that forwards mail through a personal Outlook.com account via the Microsoft Graph API. Microsoft has shut off Basic Auth for SMTP/IMAP/POP on personal Outlook.com accounts, so anything that only speaks classic SMTP has no way to send through your own account anymore. This bridge sits between them: dumb SMTP in, OAuth-authenticated Graph out.

Ships as a single Docker container with a small web GUI for setup and monitoring — no database, no build step, vanilla JS/CSS on the frontend.

## Quick start

### 1. Register an Azure app (one-time, free)

At [portal.azure.com](https://portal.azure.com) → **App registrations** → **New registration**:

- Supported account types: **Personal Microsoft accounts only**
- Authentication → Advanced settings → **Allow public client flows** = **Yes**
- No redirect URI needed, no client secret needed — this uses the OAuth device code flow, a public-client grant that has neither

Copy the **Application (client) ID**.

### 2. Run it

```bash
git clone <this repo>
cd outlook-oauth-bridge
cp .env.example .env
# edit .env: set BRIDGE_CLIENT_ID to the value from step 1
docker compose up -d
docker compose logs -f
```

The first boot prints a box to the logs, **once**:

```
╔═══════════════════════════════════════════════╗
║ outlook-oauth-bridge — first run              ║
║ Web GUI : http://<host>:8080                  ║
║ Password: xxxxxxxxxxxxxxxxxxxxxxxx            ║
║ SMTP    : <host>:2525  (STARTTLS off)         ║
║ Username: bridge                              ║
║ Password: yyyyyyyyyyyyyyyyyyyyyyyy            ║
║ This block is printed only once. Save it now. ║
╚═══════════════════════════════════════════════╝
```

Save both passwords now. If you lose the web GUI password later, see [Lost password](#lost-password) below.

### 3. Connect the account

Open the web GUI, sign in with the generated password, paste the client ID if you didn't set it via `.env`, and follow the device-code prompt (a code + a link to microsoft.com/link — sign in there with the Outlook.com account you want to relay through).

### 4. Configure your device

The GUI's **SMTP client** panel shows host/port/username/password with copy buttons and ready-to-paste snippets. In short:

| | |
|---|---|
| Host | your Docker host's address |
| Port | `2525` (see [Privileged ports](#privileged-ports) if you want 25/587) |
| Encryption | None (or STARTTLS if you've enabled `requireTls` — see below) |
| Auth | the generated `bridge` username + password |

## Configuration

All settings are in `.env` (copy from `.env.example`) — see that file for the full list with comments. The only one you need to set is `BRIDGE_CLIENT_ID`. Everything else has a sensible default.

Most day-to-day settings (rate limits, queue size/age, From-rewrite, TLS requirement, SMTP listen port) are changed in the web GUI instead of `.env` — they live in `/data/state.json` and take effect immediately, except `requireTls` and the SMTP port, which take effect on next restart (see [TLS](#tls-starttls) and [Privileged ports](#privileged-ports) below). The Settings panel's **Restart bridge** button applies those without needing shell access — it only actually restarts the process if something supervises it and brings it back (Docker's `restart: unless-stopped`, systemd, ...); under a bare `npm start` it just stops.

### Privileged ports

The container listens on `2525` internally by default, not `25` or `587` — binding a port below 1024 needs root or the `NET_BIND_SERVICE` capability, and this image deliberately runs as a non-root user (see the Dockerfile). Two ways to get a standard port, depending on what you need:

- **Just want a device to connect on the standard port?** Leave the internal port at `2525` and map it at the host instead — no app changes needed:
  ```yaml
  ports:
    - "25:2525"   # or "587:2525"
  ```
- **Want the container itself to actually bind 587?** Select it in the GUI's Settings (**SMTP listen port**) and restart. This only works if the container can bind privileged ports — either run it as root (`user: "0"` in `docker-compose.yml`, not recommended) or grant the capability yourself (`cap_add: [NET_BIND_SERVICE]` plus a Node binary built with `setcap cap_net_bind_service=+ep` on it — not shipped by default, since it can't be verified to work reliably across every Docker/kernel combination). Without one of those, the container will exit on boot with a clear "permission denied" message rather than crash-looping silently. **You must also update `docker-compose.yml`'s port mapping to match** whatever internal port you pick — the two are independent.

`465` (SMTPS / implicit TLS) is not offered as an option. This server always speaks plaintext-with-optional-STARTTLS (`secure: false`, see [TLS](#tls-starttls)); a client connecting to 465 expects an immediate TLS handshake and the connection would just fail. Implementing real implicit TLS is future work, not a configuration flag.

### TLS (STARTTLS)

STARTTLS is **off by default**, deliberately. Without a real certificate, `smtp-server` falls back to a bundled self-signed one, and a meaningful fraction of legacy devices (and strict TLS clients) either fail outright or silently upgrade and then fail in a confusing way. Plaintext-with-authentication on a trusted LAN segment is the honest default here.

If you want STARTTLS: mount real certificate files, set `BRIDGE_TLS_KEY` / `BRIDGE_TLS_CERT` in `.env` to their paths, and enable **Require TLS** in the GUI's settings. The bridge refuses to start with `requireTls` on but no certs configured, rather than silently falling back to the self-signed cert — that fallback is exactly the failure mode this design avoids.

### Lost password

If you lose the web GUI password, set `BRIDGE_RESET_PASSWORD=1` in `.env`, restart the container once, and a new password is generated and printed to the logs the same way as first-run. Remove the env var again afterward (it regenerates the password on every boot while set).

### Bind mount ownership

The default `docker-compose.yml` uses a named volume for `/data`, which Docker seeds with the image's directory ownership (uid 1000) automatically — no setup needed. If you switch to a bind mount instead, the host directory needs the same ownership:

```bash
sudo chown -R 1000:1000 /path/to/your/data/dir
```

Without this, the container exits on boot with a clear `EACCES` message rather than a bare stack trace.

## Honest limitations

- **Messages over ~3 MiB are rejected (`552`).** Graph's `sendMail` MIME endpoint caps the base64 request body at 4 MiB; the raw-message budget after that encoding overhead is ~3 MiB. There's no chunked-upload fallback — this bridge is for small, dumb-device mail (scan notifications, alerts, status mail), not attachments.
- **A message can duplicate under one specific failure mode.** `sendMail` has no idempotency key and a `202` response means "accepted," not "delivered." If the network request times out or resets *after* it may have reached Graph, a retry can send a duplicate — this is undetectable by design of the API. The bridge caps retries at 2 attempts specifically for this ambiguous failure class (vs. 8 for ordinary transient errors) to limit the blast radius, and tags it "may have been delivered" in the activity feed and dead-letter reason. It cannot be fully eliminated.
- **Outlook.com has its own, unpublished sending limits** for personal accounts (daily recipient caps, per-hour throttles). A chatty script can trip these independently of the bridge's own rate limiting. If mail starts failing with `429`s, this is usually why.
- **The SMTP and refresh-token credentials are stored in plaintext** in `/data/state.json` (mode `0600`, directory `0700`). Hashing the SMTP password would be theater — the same file holds the OAuth refresh token, which already grants full send-as access to the mailbox and is inherently at least as sensitive. Anyone with read access to the container's filesystem or a backup of the volume has both. There is no encryption-at-rest option in this version; if that matters for your threat model, encrypt the underlying disk/volume instead.
- **No message receiving.** This is a send-only relay — no IMAP/POP, no inbound delivery.
- **Retry timing (backoff waits) can't be meaningfully tested on Windows dev machines** the same way as on Linux, because Windows doesn't deliver real `SIGTERM` to child processes the way containers rely on — this only affects local development tooling, not the container itself, which runs on Linux.

## Security

- **The single largest risk is inherent to the product**: anyone who obtains the SMTP credential can send mail as your real Outlook identity, with valid SPF/DKIM/DMARC. Mitigations built in: authentication is always required (no configuration path disables it), credentials are strong and randomly generated, per-IP brute-force banning on both the SMTP and web GUI logins, rate limiting, and every send is visible in the live activity feed. Keep the container on a trusted network segment and don't port-forward the SMTP port to the internet.
- **The web GUI runs over plain HTTP by default.** Put a TLS-terminating reverse proxy in front of it if it's reachable beyond a trusted LAN, and set `BRIDGE_TRUST_TLS=1` so the session cookie gets the `Secure` flag.
- **Revoking access**: disconnecting in the GUI clears the local refresh token. To fully revoke it on Microsoft's side (e.g. after a suspected compromise), visit [account.live.com/consent/Manage](https://account.live.com/consent/Manage).
- Full design rationale and threat model live in `ARCHITECTURE.md`.

## Development

```bash
npm install
cp .env.example .env   # fill in BRIDGE_CLIENT_ID for manual testing
npm test                # node's built-in test runner, no dependencies
npm start                # BRIDGE_DATA_DIR defaults to /data — override for local runs, e.g.:
BRIDGE_DATA_DIR=./data npm start
```

`test/fake-graph.js` mocks `login.microsoftonline.com` and `graph.microsoft.com` so the whole stack (SMTP → MIME processing → queue → Graph) can be tested end-to-end without a real Microsoft account or network access — see `test/e2e.test.js`.

## License

MIT — see `LICENSE`.
