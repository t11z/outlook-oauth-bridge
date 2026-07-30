const $ = (id) => document.getElementById(id);

// Monoline SVG icons — no emoji. Single stroke weight, 20x20 viewBox.
const ICON = {
    copy: '<svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><rect x="7" y="7" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4 13V5a1 1 0 0 1 1-1h8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    check: '<svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><path d="M4 10.5l4 4L16 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    eye: '<svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="10" cy="10" r="2.25" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    eyeOff:
        '<svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="10" cy="10" r="2.25" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3 3l14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    refresh:
        '<svg viewBox="0 0 20 20" width="13" height="13" aria-hidden="true"><path d="M16 4v4h-4M4 16v-4h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 8a5.5 5.5 0 0 0-9.5-2.5M5 12a5.5 5.5 0 0 0 9.5 2.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    trash: '<svg viewBox="0 0 20 20" width="13" height="13" aria-hidden="true"><path d="M4 6h12M8 6V4.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V6M6 6l.6 9.4a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9L14 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    download:
        '<svg viewBox="0 0 20 20" width="13" height="13" aria-hidden="true"><path d="M10 3v9M6.5 9l3.5 3.5L13.5 9M4 15.5h12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

let dashboard = null;
let csrfToken = null;
let evtSource = null;
let deviceCodeCountdownTimer = null;
let tokenLifeTimer = null;
let queueRefreshTimer = null;

// ---------------------------------------------------------------------------
// API helper — every mutating call carries Content-Type: application/json
// and the CSRF header, matching what the server requires.
// ---------------------------------------------------------------------------

async function api(path, { method = 'GET', body } = {}) {
    const headers = {};
    let payload;
    if (method !== 'GET') {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body ?? {});
        if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    }
    const res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' });
    if (res.status === 401) {
        showLogin();
        throw new Error('unauthorized');
    }
    const contentType = res.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await res.json().catch(() => null) : null;
    if (!res.ok) {
        const err = new Error((data && (data.message || data.error)) || `Request failed (${res.status})`);
        err.status = res.status;
        err.data = data;
        throw err;
    }
    // /api/state carries a fresh CSRF token on every response — this is what lets a
    // page reload with an existing session cookie (no fresh /api/login) still make
    // authenticated POST requests, instead of leaving this module's csrfToken unset.
    if (data && typeof data.csrfToken === 'string') csrfToken = data.csrfToken;
    return data;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function initTheme() {
    const saved = localStorage.getItem('oob-theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
    $('theme-toggle').addEventListener('click', () => {
        const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
        const current = document.documentElement.getAttribute('data-theme') || (prefersDark ? 'dark' : 'light');
        const next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('oob-theme', next);
    });
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

function toast(message, { error = false } = {}) {
    const el = document.createElement('div');
    el.className = 'toast' + (error ? ' toast--err' : '');
    el.setAttribute('role', 'status');
    el.textContent = message;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 4000);
}

// ---------------------------------------------------------------------------
// Auth / boot
// ---------------------------------------------------------------------------

function showLogin() {
    $('view-login').hidden = false;
    $('view-app').hidden = true;
    stopSse();
}

function showApp() {
    $('view-login').hidden = true;
    $('view-app').hidden = false;
}

async function boot() {
    initTheme();
    wireLoginForm();
    wireForms();
    try {
        dashboard = await api('/api/state');
        showApp();
        render();
        connectSse();
        startQueuePolling();
    } catch {
        showLogin();
    }
}

function wireLoginForm() {
    $('login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        $('login-error').hidden = true;
        const password = $('login-password').value;
        try {
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                $('login-error').textContent = res.status === 429 ? 'Too many attempts. Try again in a bit.' : 'Invalid password.';
                $('login-error').hidden = false;
                return;
            }
            csrfToken = data.csrfToken;
            $('login-password').value = '';
            dashboard = await api('/api/state');
            showApp();
            render();
            connectSse();
            startQueuePolling();
        } catch {
            $('login-error').textContent = 'Network error.';
            $('login-error').hidden = false;
        }
    });
}

// ---------------------------------------------------------------------------
// SSE — replayed feed on connect, then live
// ---------------------------------------------------------------------------

function connectSse() {
    evtSource = new EventSource('/api/events');
    evtSource.onmessage = (e) => {
        let event;
        try {
            event = JSON.parse(e.data);
        } catch {
            return;
        }
        handleEvent(event);
    };
}

function stopSse() {
    if (evtSource) {
        evtSource.close();
        evtSource = null;
    }
}

const FEED_TYPES = new Set(['queued', 'sending', 'sent', 'retry', 'dead', 'auth', 'auth-failure', 'paused', 'resumed']);
const STATE_REFRESH_TYPES = new Set(['queued', 'sending', 'sent', 'retry', 'dead', 'paused', 'resumed']);

function handleEvent(event) {
    if (FEED_TYPES.has(event.type)) pushFeedRow(event);
    if (event.type === 'auth') applyAuthEvent(event);
    if (STATE_REFRESH_TYPES.has(event.type)) scheduleStateRefresh();
}

function scheduleStateRefresh() {
    if (queueRefreshTimer) return;
    queueRefreshTimer = setTimeout(async () => {
        queueRefreshTimer = null;
        try {
            const fresh = await api('/api/state');
            dashboard.counters = fresh.counters;
            dashboard.queue = fresh.queue;
            dashboard.oauth = fresh.oauth;
            renderBadges();
            renderConnection();
        } catch {
            /* ignore transient refresh failures */
        }
        refreshQueuePanel();
    }, 400);
}

function applyAuthEvent(event) {
    const oauth = dashboard.oauth;
    if (event.status === 'device_code') {
        oauth.pendingDeviceCode = { userCode: event.userCode, verificationUri: event.verificationUri, expiresAt: event.expiresAt };
        if (oauth.status === 'unconfigured') oauth.status = 'connecting';
    } else if (event.status === 'connected') {
        oauth.pendingDeviceCode = null;
        oauth.status = 'connected';
        if (event.account) oauth.account = event.account;
        oauth.lastError = null;
    } else if (event.status === 'needs_reauth') {
        oauth.status = 'needs_reauth';
        oauth.lastError = { message: event.message };
    } else if (event.status === 'declined' || event.status === 'expired' || event.status === 'cancelled') {
        oauth.pendingDeviceCode = null;
    } else if (event.status === 'error') {
        oauth.pendingDeviceCode = null;
        toast(event.message || 'Connection error', { error: true });
    } else if (event.status === 'disconnected') {
        oauth.status = 'unconfigured';
        oauth.account = null;
        oauth.pendingDeviceCode = null;
    }
    render();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
    renderBadges();
    renderConnection();
    renderClientConfig();
    renderSettings();
}

function renderBadges() {
    const wrap = $('statusline');
    wrap.innerHTML = '';
    const oauth = dashboard.oauth;

    let lampClass = '';
    let label = 'not connected';
    if (oauth.status === 'connected') {
        lampClass = 'lamp--ok';
        label = oauth.account?.address || 'connected';
    } else if (oauth.status === 'needs_reauth') {
        lampClass = 'lamp--err lamp--pulse';
        label = 'needs reconnect';
    } else if (oauth.status === 'connecting') {
        lampClass = 'lamp--warn';
        label = 'connecting…';
    }
    const conn = document.createElement('span');
    conn.className = 'readout';
    conn.innerHTML = `<span class="lamp ${lampClass}"></span><span>${escapeHtml(label)}</span>`;
    wrap.appendChild(conn);

    const counters = dashboard.counters;
    const stat = document.createElement('span');
    stat.className = 'stat';
    stat.innerHTML = `<strong>${counters.sent}</strong> sent &middot; <strong>${counters.failed}</strong> failed &middot; <strong>${counters.dead}</strong> dead &middot; <strong>${dashboard.queue.depth}</strong> queued`;
    wrap.appendChild(stat);

    if (dashboard.queue.paused) {
        const paused = document.createElement('span');
        paused.className = 'readout';
        paused.innerHTML = '<span class="lamp lamp--warn lamp--pulse"></span><span>paused</span>';
        wrap.appendChild(paused);
    }
}

function renderConnection() {
    const oauth = dashboard.oauth;

    $('card-setup').hidden = oauth.status !== 'unconfigured';
    $('card-reauth').hidden = oauth.status !== 'needs_reauth';
    if (oauth.status === 'needs_reauth') {
        $('reauth-message').textContent = oauth.lastError?.message || 'The connection to Outlook.com needs to be re-established.';
    }

    $('card-connection').hidden = oauth.status === 'unconfigured';
    $('card-client-config').hidden = oauth.status === 'unconfigured';
    $('card-test-mail').hidden = oauth.status !== 'connected';

    const connectedAndSettled = oauth.status === 'connected' && !oauth.pendingDeviceCode;
    $('connection-connected').hidden = !connectedAndSettled;
    $('device-code-panel').hidden = !oauth.pendingDeviceCode;

    if (connectedAndSettled) {
        $('account-name').textContent = oauth.account?.displayName || '';
        $('account-address').textContent = oauth.account?.address || '';
        $('account-avatar').textContent = (oauth.account?.displayName || '?').slice(0, 1).toUpperCase();
        renderTokenLife();
    }

    if (oauth.pendingDeviceCode) renderDeviceCode(oauth.pendingDeviceCode);
    else stopDeviceCodeCountdown();
}

function renderDeviceCode(info) {
    $('device-code-link').href = info.verificationUri;
    $('device-code-value').textContent = info.userCode;
    stopDeviceCodeCountdown();
    const tick = () => {
        const remaining = Math.max(0, info.expiresAt - Date.now());
        const m = Math.floor(remaining / 60000);
        const s = Math.floor((remaining % 60000) / 1000);
        $('device-code-countdown').textContent = `${m}:${String(s).padStart(2, '0')}`;
        if (remaining <= 0) stopDeviceCodeCountdown();
    };
    tick();
    deviceCodeCountdownTimer = setInterval(tick, 1000);
}

function stopDeviceCodeCountdown() {
    if (deviceCodeCountdownTimer) {
        clearInterval(deviceCodeCountdownTimer);
        deviceCodeCountdownTimer = null;
    }
}

function renderTokenLife() {
    const expiresAt = dashboard.oauth.tokenExpiresAt;
    if (tokenLifeTimer) clearInterval(tokenLifeTimer);
    if (!expiresAt) {
        $('token-life-label').textContent = '';
        $('token-life-fill').style.width = '0%';
        return;
    }
    const approxLifetimeMs = 3600_000;
    const tick = () => {
        const remaining = Math.max(0, expiresAt - Date.now());
        const pct = Math.max(0, Math.min(100, (remaining / approxLifetimeMs) * 100));
        $('token-life-fill').style.width = pct + '%';
        const mins = Math.floor(remaining / 60000);
        $('token-life-label').textContent = remaining > 0 ? `Token expires in ${mins}m` : 'Token expired, refreshing…';
    };
    tick();
    tokenLifeTimer = setInterval(tick, 15000);
}

function renderClientConfig() {
    $('cfg-host').value = location.hostname;
    $('cfg-port').value = dashboard.smtp.port;
    $('cfg-user').value = dashboard.smtp.username;
    $('cfg-pass').value = dashboard.smtp.password;
    renderSnippet();
}

function renderSnippet() {
    const active = document.querySelector('.segmented-btn.is-active')?.dataset.snippet || 'generic';
    const host = location.hostname;
    const port = dashboard.smtp.port;
    const user = dashboard.smtp.username;
    const pass = dashboard.smtp.password;
    const snippets = {
        generic: `Host: ${host}\nPort: ${port}\nEncryption: None (or STARTTLS if enabled)\nUsername: ${user}\nPassword: ${pass}`,
        python: `import smtplib\n\ns = smtplib.SMTP("${host}", ${port})\ns.login("${user}", "${pass}")\ns.sendmail("${user}", ["someone@example.com"], "Subject: Test\\n\\nHello")\ns.quit()`,
    };
    $('snippet-output').textContent = snippets[active] || snippets.generic;
}

function renderSettings() {
    const s = dashboard.settings;
    $('setting-fromRewrite').checked = s.fromRewrite;
    $('setting-requireTls').checked = s.requireTls;
    $('setting-rateLimitPerMin').value = s.rateLimitPerMin;
    $('setting-rateLimitPerDay').value = s.rateLimitPerDay;
    $('setting-maxQueueDepth').value = s.maxQueueDepth;
    $('setting-queueMaxAgeHours').value = s.queueMaxAgeHours;
}

// ---------------------------------------------------------------------------
// Live feed
// ---------------------------------------------------------------------------

const FEED_CAP = 200;

function feedLampClass(type) {
    if (type === 'sent') return 'lamp--ok';
    if (type === 'dead' || type === 'auth-failure') return 'lamp--err';
    if (type === 'retry' || type === 'paused') return 'lamp--warn';
    return '';
}

function feedLabel(event) {
    switch (event.type) {
        case 'queued':
            return `queued (${event.size} bytes)`;
        case 'sending':
            return `sending (attempt ${event.attempt})`;
        case 'sent':
            return 'sent';
        case 'retry':
            return `retry ${event.attempts} — ${event.reason || ''}`;
        case 'dead':
            return `dead-lettered — ${event.reason || ''}`;
        case 'auth':
            return `auth: ${event.status}`;
        case 'auth-failure':
            return `SMTP auth failed (${event.ip})`;
        case 'paused':
            return `paused — ${event.reason}`;
        case 'resumed':
            return 'resumed';
        default:
            return event.type;
    }
}

function feedMessage(event) {
    if (event.type === 'auth') {
        if (event.status === 'connected') return event.account?.address || 'connected';
        if (event.status === 'device_code') return event.verificationUri || 'device code issued';
        if (event.status === 'needs_reauth' || event.status === 'error') return event.message || '';
        return '';
    }
    return event.subject || event.message || '';
}

function pushFeedRow(event) {
    $('feed-empty').hidden = true;
    const list = $('feed-list');
    const li = document.createElement('li');
    li.className = 'feed-row';
    const time = new Date(event.at).toLocaleTimeString();
    li.innerHTML =
        `<span class="feed-time mono">${time}</span>` +
        `<span class="lamp ${feedLampClass(event.type)}"></span>` +
        `<span class="feed-msg">${escapeHtml(feedMessage(event))}</span>` +
        `<span class="feed-status">${escapeHtml(feedLabel(event))}</span>`;
    li.addEventListener('click', () => {
        const existing = li.querySelector('.feed-detail');
        if (existing) {
            existing.remove();
            return;
        }
        const detail = document.createElement('div');
        detail.className = 'feed-detail';
        detail.textContent = JSON.stringify(event, null, 2);
        li.appendChild(detail);
    });
    list.prepend(li);
    while (list.children.length > FEED_CAP) list.lastElementChild.remove();
}

// ---------------------------------------------------------------------------
// Queue & dead letters
// ---------------------------------------------------------------------------

function startQueuePolling() {
    refreshQueuePanel();
    setInterval(refreshQueuePanel, 15000);
}

async function refreshQueuePanel() {
    try {
        const data = await api('/api/queue');
        renderQueueTable(data.active);
        renderDeadTable(data.dead);
    } catch {
        /* ignore — next poll or event will retry */
    }
}

function actionButton(iconKey, label, onClick, danger = false) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn--ghost small' + (danger ? ' btn--danger' : '');
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = ICON[iconKey];
    b.addEventListener('click', onClick);
    return b;
}

function downloadLink(href) {
    const a = document.createElement('a');
    a.href = href;
    a.className = 'btn btn--ghost small';
    a.title = 'Download .eml';
    a.setAttribute('aria-label', 'Download .eml');
    a.innerHTML = ICON.download;
    return a;
}

function renderQueueTable(items) {
    const tbody = $('queue-tbody');
    tbody.innerHTML = '';
    for (const m of items) {
        const tr = document.createElement('tr');
        const next = m.nextAttemptAt > Date.now() ? new Date(m.nextAttemptAt).toLocaleTimeString() : 'now';
        const tdSubject = document.createElement('td');
        tdSubject.textContent = m.subject || '(no subject)';
        const tdAttempts = document.createElement('td');
        tdAttempts.className = 'mono';
        tdAttempts.textContent = m.attempts;
        const tdNext = document.createElement('td');
        tdNext.className = 'mono';
        tdNext.textContent = next;
        const tdActions = document.createElement('td');
        tdActions.className = 'actions';
        tdActions.append(
            actionButton('refresh', 'Retry now', () => queueAction(m.id, 'retry')),
            actionButton('trash', 'Discard', () => queueAction(m.id, 'discard'), true),
            downloadLink(`/api/queue/${m.id}/eml`)
        );
        tr.append(tdSubject, tdAttempts, tdNext, tdActions);
        tbody.appendChild(tr);
    }
    $('card-queue').hidden = items.length === 0;
}

function renderDeadTable(items) {
    const tbody = $('dead-tbody');
    tbody.innerHTML = '';
    for (const m of items) {
        const tr = document.createElement('tr');
        const tdSubject = document.createElement('td');
        tdSubject.textContent = m.subject || '(no subject)';
        const tdReason = document.createElement('td');
        tdReason.className = 'text-muted';
        tdReason.textContent = m.lastError?.message || '';
        const tdActions = document.createElement('td');
        tdActions.className = 'actions';
        tdActions.append(
            actionButton('refresh', 'Retry', () => queueAction(m.id, 'retry')),
            actionButton('trash', 'Discard', () => queueAction(m.id, 'discard'), true),
            downloadLink(`/api/queue/${m.id}/eml`)
        );
        tr.append(tdSubject, tdReason, tdActions);
        tbody.appendChild(tr);
    }
    $('card-dead').hidden = items.length === 0;
}

async function queueAction(id, action) {
    try {
        if (action === 'retry') await api(`/api/queue/${id}/retry`, { method: 'POST' });
        else await api(`/api/queue/${id}`, { method: 'DELETE' });
        await refreshQueuePanel();
    } catch (err) {
        toast(err.message, { error: true });
    }
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

async function startDeviceCode() {
    try {
        const info = await api('/api/oauth/device/start', { method: 'POST' });
        dashboard.oauth.pendingDeviceCode = info;
        if (dashboard.oauth.status === 'unconfigured') dashboard.oauth.status = 'connecting';
        render();
    } catch (err) {
        toast(err.message, { error: true });
    }
}

function wireForms() {
    $('logout-btn').addEventListener('click', async () => {
        try {
            await api('/api/logout', { method: 'POST' });
        } catch {
            /* proceed to login view regardless */
        }
        csrfToken = null;
        showLogin();
    });

    $('client-id-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const clientId = $('client-id-input').value.trim();
        try {
            await api('/api/oauth/client', { method: 'POST', body: { clientId } });
            toast('Client ID saved.');
            await startDeviceCode();
        } catch (err) {
            toast(err.message, { error: true });
        }
    });

    $('reconnect-btn').addEventListener('click', startDeviceCode);

    $('disconnect-btn').addEventListener('click', async () => {
        try {
            await api('/api/oauth/disconnect', { method: 'POST' });
            dashboard = await api('/api/state');
            render();
        } catch (err) {
            toast(err.message, { error: true });
        }
    });

    $('device-code-cancel').addEventListener('click', async () => {
        try {
            await api('/api/oauth/device/cancel', { method: 'POST' });
        } catch {
            /* ignore */
        }
    });

    $('smtp-regen-btn').addEventListener('click', async () => {
        try {
            const res = await api('/api/smtp/regenerate', { method: 'POST' });
            dashboard.smtp.password = res.password;
            renderClientConfig();
            toast('SMTP password regenerated.');
        } catch (err) {
            toast(err.message, { error: true });
        }
    });

    $('cfg-pass-reveal').innerHTML = ICON.eye;
    $('cfg-pass-reveal').addEventListener('click', () => {
        const input = $('cfg-pass');
        const btn = $('cfg-pass-reveal');
        const willShow = input.type === 'password';
        input.type = willShow ? 'text' : 'password';
        btn.innerHTML = willShow ? ICON.eyeOff : ICON.eye;
    });

    document.querySelectorAll('.copy-btn').forEach((btn) => {
        btn.innerHTML = ICON.copy;
        btn.addEventListener('click', () => {
            const target = document.getElementById(btn.dataset.copyTarget);
            navigator.clipboard?.writeText(target.value).then(() => {
                btn.innerHTML = ICON.check;
                btn.classList.add('is-copied');
                setTimeout(() => {
                    btn.innerHTML = ICON.copy;
                    btn.classList.remove('is-copied');
                }, 1200);
            });
        });
    });

    $('device-code-copy').innerHTML = ICON.copy;
    $('device-code-copy').addEventListener('click', () => {
        navigator.clipboard?.writeText($('device-code-value').textContent || '').then(() => {
            $('device-code-copy').innerHTML = ICON.check;
            setTimeout(() => ($('device-code-copy').innerHTML = ICON.copy), 1200);
        });
    });

    document.querySelectorAll('.segmented-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.segmented-btn').forEach((b) => b.classList.remove('is-active'));
            btn.classList.add('is-active');
            renderSnippet();
        });
    });

    $('test-mail-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const to = $('test-mail-to').value.trim();
        $('test-mail-result').textContent = 'Sending…';
        try {
            await api('/api/test-mail', { method: 'POST', body: { to } });
            $('test-mail-result').textContent = 'Queued — check the live feed below.';
        } catch (err) {
            $('test-mail-result').textContent = err.message;
        }
    });

    $('settings-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const patch = {
            fromRewrite: $('setting-fromRewrite').checked,
            requireTls: $('setting-requireTls').checked,
            rateLimitPerMin: Number($('setting-rateLimitPerMin').value),
            rateLimitPerDay: Number($('setting-rateLimitPerDay').value),
            maxQueueDepth: Number($('setting-maxQueueDepth').value),
            queueMaxAgeHours: Number($('setting-queueMaxAgeHours').value),
        };
        try {
            const res = await api('/api/settings', { method: 'POST', body: patch });
            dashboard.settings = res.settings;
            toast('Settings saved.');
        } catch (err) {
            toast(err.message, { error: true });
        }
    });

    $('password-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const current = $('pw-current').value;
        const next = $('pw-next').value;
        try {
            await api('/api/password', { method: 'POST', body: { current, next } });
            $('password-form').reset();
            toast('Password changed.');
        } catch (err) {
            toast(err.message, { error: true });
        }
    });
}

boot();
