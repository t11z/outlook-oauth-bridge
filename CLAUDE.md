# outlook-oauth-bridge

SMTP-to-Outlook.com relay for OAuth-incapable devices. Node.js, `smtp-server` as the only runtime dependency, vanilla JS/CSS frontend, no build step, no database, no framework.

- **What it does, configuration, security model, honest limitations:** `README.md`
- **Why the code is organized this way, non-obvious constraints, bugs already fixed once — don't reintroduce them:** `ARCHITECTURE.md`

## Layout

```
src/        config.js, store.js, events.js, mime.js, smtp.js, oauth.js, graph.js, queue.js, web/
public/     index.html, app.js, style.css — vanilla, no bundler
test/       fake-graph.js (mock), mime.test.js, e2e.test.js
```

## Commands

```bash
npm test            # node --test — no path argument (see note below)
npm start            # BRIDGE_DATA_DIR defaults to /data; override for local runs
```

`npm test` runs bare `node --test` with no path. Passing an explicit `test/` path has failed to resolve on at least one Windows/Node 22 combination here — the bare form auto-discovers recursively and works everywhere, so don't add a path back to the script.

## One invariant worth knowing before touching `web/api.js`

`state.json` holds `web.passwordHash`, `web.sessionSecret`, and `oauth.refreshToken`. Never spread `store.state` into an API response — `projectState()` names every exposed field explicitly. A new state field does not automatically become visible to the GUI; that's intentional.
