'use strict';

// SN Assignflow — on-page dispatcher widget and assignment engine
//
// The engine runs here rather than in the background on purpose. A Manifest V3
// service worker is torn down when idle, which would kill the cycle timer
// mid-run; a content script's timers live exactly as long as the tab does. It
// also means every request is same-origin to the instance in this tab and rides
// the session that is already open, with no cross-origin credentials anywhere.

(function () {

// Injected both by the manifest and, for tabs that predate the install, by
// chrome.scripting from the background. Either way it must only take effect
// once — but the message listener from the first run has to stay live, which is
// why this returns instead of tearing anything down.
if (window.__snafLoaded) return;
window.__snafLoaded = true;

// Top frame only. In classic UI the form lives in the gsft_main iframe, but the
// widget belongs to the shell and the engine only needs the instance origin.
if (window.top !== window) return;

// ── State ─────────────────────────────────────────────────────────────────────
let groups        = [];
let settings      = snafDefaultSettings();
let directory     = [];

let engine        = 'stopped';   // stopped | running | paused
let visible       = false;
let minimized     = false;

let intervalSecs  = 60;
let remainingMs   = 0;
let tickTimer     = null;

let sessionCount  = 0;
let totalCount    = 0;
let cycleCount    = 0;
let scopeId       = null;

let token         = null;
let tokenTried    = false;

// Whether this page is an instance we should act on. Null until resolved.
// Relevant because the content script can be registered for all sites, and a
// broad grant is a convenience rather than a claim that every site is
// ServiceNow — see resolveTrust below.
let snTrusted     = null;

// ── Icons ─────────────────────────────────────────────────────────────────────
const SVG = {
    fork: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">' +
          '<circle cx="4.5" cy="12" r="2.4" fill="#fff" stroke="none"/><path d="M7.4 12h3.1"/>' +
          '<path d="M10.5 12 17.2 5.3"/><path d="M10.5 12 17.2 18.7"/>' +
          '<path d="M13.6 5.3h3.6v3.6"/><path d="M13.6 18.7h3.6v-3.6"/></svg>',
    minimize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 12h12"/></svg>',
    close:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
    play:     '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.2v13.6L19 12z"/></svg>',
    pause:    '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="6" width="3.6" height="12" rx="1.1"/><rect x="13.4" y="6" width="3.6" height="12" rx="1.1"/></svg>',
    stop:     '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="6.5" width="11" height="11" rx="1.8"/></svg>',
    sliders:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h9"/><path d="M19 7h1"/><path d="M4 17h1"/><path d="M11 17h9"/><circle cx="16" cy="7" r="2.3"/><circle cx="8" cy="17" r="2.3"/></svg>',
    pulse:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h4l2.5-6 4 13 2.5-7h7"/></svg>',
    warn:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4.5 3.2 19.5h17.6z"/><path d="M12 10v4"/><path d="M12 17.2h.01"/></svg>',
    info:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.6"/><path d="M12 11v5"/><path d="M12 7.9h.01"/></svg>'
};

// ── Shell ─────────────────────────────────────────────────────────────────────
const host = document.createElement('div');
host.id = 'snaf-widget';
host.style.display = 'none';
host.setAttribute('role', 'complementary');
host.setAttribute('aria-label', 'SN Assignflow dispatcher');
host.innerHTML =
    '<div id="snaf-pill" role="button" tabindex="0" aria-label="Expand SN Assignflow">' +
      '<div id="snaf-pill-mark">' + SVG.fork + '</div>' +
      '<div id="snaf-pill-text">' +
        '<div id="snaf-pill-name">SN Assignflow</div>' +
        '<div id="snaf-pill-state">Stopped</div>' +
      '</div>' +
      '<div id="snaf-pill-timer"></div>' +
    '</div>' +

    '<div id="snaf-panel">' +
      '<div id="snaf-head">' +
        '<div id="snaf-head-mark">' + SVG.fork + '</div>' +
        '<div id="snaf-head-text">' +
          '<div id="snaf-head-name"><span id="snaf-dot"></span><span>SN Assignflow</span></div>' +
          '<div id="snaf-head-state">Stopped</div>' +
        '</div>' +
        '<div id="snaf-head-btns">' +
          '<button class="snaf-hbtn" id="snaf-min" title="Minimise" aria-label="Minimise">' + SVG.minimize + '</button>' +
          '<button class="snaf-hbtn close" id="snaf-close" title="Close widget" aria-label="Close widget">' + SVG.close + '</button>' +
        '</div>' +
      '</div>' +

      '<div id="snaf-stats">' +
        '<div class="snaf-stat"><div class="snaf-stat-val" id="snaf-s-session">0</div><div class="snaf-stat-lbl">Session</div></div>' +
        '<div class="snaf-stat"><div class="snaf-stat-val" id="snaf-s-total">0</div><div class="snaf-stat-lbl">All time</div></div>' +
        '<div class="snaf-stat"><div class="snaf-stat-val" id="snaf-s-groups">0</div><div class="snaf-stat-lbl">Groups</div></div>' +
        '<div class="snaf-stat"><div class="snaf-stat-val" id="snaf-s-cycles">0</div><div class="snaf-stat-lbl">Cycles</div></div>' +
      '</div>' +

      '<div id="snaf-timer-row">' +
        '<span id="snaf-timer-lbl">Next run</span>' +
        '<div id="snaf-timer-track"><div id="snaf-timer-fill"></div></div>' +
        '<span id="snaf-timer-val">&mdash;</span>' +
      '</div>' +

      '<div id="snaf-scope-row">' +
        '<span id="snaf-scope-lbl">Scope</span>' +
        '<select class="snaf-select" id="snaf-scope" aria-label="Group scope"><option value="">All active groups</option></select>' +
      '</div>' +

      '<div id="snaf-controls">' +
        '<button class="snaf-btn snaf-btn-start" id="snaf-start">' + SVG.play + '<span>Start</span></button>' +
        '<button class="snaf-btn snaf-btn-pause" id="snaf-pause" style="display:none">' + SVG.pause + '<span>Pause</span></button>' +
        '<button class="snaf-btn snaf-btn-stop" id="snaf-stop" style="display:none">' + SVG.stop + '<span>Stop</span></button>' +
        '<button class="snaf-btn snaf-btn-icon" id="snaf-config" title="Open configuration" aria-label="Open configuration">' + SVG.sliders + '</button>' +
      '</div>' +

      '<div id="snaf-notice"></div>' +
      '<div id="snaf-log" role="log" aria-live="polite"></div>' +

      '<div id="snaf-foot">' +
        '<div id="snaf-foot-left">' +
          '<span id="snaf-host"></span>' +
          '<span id="snaf-ka" title="Session keep-alive is active">' + SVG.pulse + '</span>' +
        '</div>' +
        '<div id="snaf-foot-right">' +
          '<span id="snaf-interval-lbl">Every</span>' +
          '<select class="snaf-select" id="snaf-interval" aria-label="Cycle interval"></select>' +
        '</div>' +
      '</div>' +
    '</div>';

(document.body || document.documentElement).appendChild(host);

const $ = id => document.getElementById(id);

const elPill      = $('snaf-pill');
const elPillState = $('snaf-pill-state');
const elPillTimer = $('snaf-pill-timer');
const elPanel     = $('snaf-panel');
const elHead      = $('snaf-head');
const elDot       = $('snaf-dot');
const elHeadState = $('snaf-head-state');
const elMin       = $('snaf-min');
const elClose     = $('snaf-close');
const elSession   = $('snaf-s-session');
const elTotal     = $('snaf-s-total');
const elGroups    = $('snaf-s-groups');
const elCycles    = $('snaf-s-cycles');
const elFill      = $('snaf-timer-fill');
const elTimerVal  = $('snaf-timer-val');
const elScope     = $('snaf-scope');
const elStart     = $('snaf-start');
const elPause     = $('snaf-pause');
const elStop      = $('snaf-stop');
const elConfig    = $('snaf-config');
const elNotice    = $('snaf-notice');
const elLog       = $('snaf-log');
const elHost      = $('snaf-host');
const elKa        = $('snaf-ka');
const elInterval  = $('snaf-interval');

elHost.textContent = location.hostname;
elHost.title       = location.hostname;

// Interval options come from the shared list so the widget and the Rules panel
// can never drift apart.
function intervalLabel(secs) {
    if (secs < 60) return secs + 's';
    const m = secs / 60;
    return (Number.isInteger(m) ? m : m.toFixed(1)) + 'm';
}
SNAF_INTERVAL_STEPS.forEach(secs => {
    const o = document.createElement('option');
    o.value       = String(secs);
    o.textContent = intervalLabel(secs);
    elInterval.appendChild(o);
});

// ── Logging ───────────────────────────────────────────────────────────────────
let logQueue   = [];
let flushTimer = null;

function flushLogs() {
    flushTimer = null;
    if (!logQueue.length) return;
    const batch = logQueue;
    logQueue = [];
    chrome.storage.local.get(SNAF_KEY_LOGS).then(store => {
        const list = (Array.isArray(store[SNAF_KEY_LOGS]) ? store[SNAF_KEY_LOGS] : []).concat(batch);
        while (list.length > SNAF_LOG_LIMIT) list.shift();
        const patch = {};
        patch[SNAF_KEY_LOGS] = list;
        return chrome.storage.local.set(patch);
    }).catch(() => {});
}

// Batched rather than written per line: a busy cycle produces hundreds of lines
// and one storage write each would be wasteful.
function persist(level, msg) {
    if (!settings.logs.persist) return;
    logQueue.push({ t: Date.now(), host: location.hostname, lv: level, msg: msg });
    if (!flushTimer) flushTimer = setTimeout(flushLogs, 1500);
}

// Text is always set through textContent — ticket numbers and user names come
// from the instance and are treated as untrusted.
function log(msg, level, indent) {
    const line = document.createElement('div');
    line.className = 'snaf-log-line' + (level ? ' lv-' + level : '') + (indent ? ' indent' : '');

    const when = document.createElement('span');
    when.className   = 'snaf-log-when';
    when.textContent = snafTimestamp();

    const text = document.createElement('span');
    text.className   = 'snaf-log-msg';
    text.textContent = msg;

    line.appendChild(when);
    line.appendChild(text);
    elLog.appendChild(line);
    elLog.scrollTop = elLog.scrollHeight;

    while (elLog.children.length > 200) elLog.removeChild(elLog.firstChild);
    persist(level || 'info', (indent ? '  ' : '') + msg);
}

// ── Notice strip ──────────────────────────────────────────────────────────────
function setNotice(msg, kind) {
    if (!msg) { elNotice.className = ''; elNotice.textContent = ''; return; }
    elNotice.className = 'is-open ' + (kind || 'info');
    elNotice.innerHTML = (kind === 'warn' ? SVG.warn : SVG.info);
    const span = document.createElement('span');
    span.textContent = msg;
    elNotice.appendChild(span);
}

function refreshNotice() {
    if (snTrusted === false) {
        setNotice('This page does not look like a ServiceNow instance, so nothing will run here. ' +
                  'If it is one, add its domain under Settings → Instances.', 'warn');
    } else if (settings.rules.dryRun) {
        setNotice('Dry run is on. Assignments are logged but nothing is written to the instance.', 'warn');
    } else {
        setNotice('');
    }
    host.classList.toggle('is-dry', !!settings.rules.dryRun);
}

// Three cases, in order of confidence:
//   1. *.service-now.com — built into the manifest, always an instance.
//   2. A host the user added under Settings → Instances. They declared it an
//      instance, so it is taken on their word.
//   3. Everything else, which only happens under an all-sites grant. That grant
//      was given for convenience, not as a statement about every site, so the
//      page has to actually look like ServiceNow.
async function resolveTrust() {
    const hostname = location.hostname;
    if (snafIsServiceNowCloud(hostname)) return true;

    let patterns = [];
    try {
        const store = await chrome.storage.local.get(SNAF_KEY_DOMAINS);
        if (Array.isArray(store[SNAF_KEY_DOMAINS])) patterns = store[SNAF_KEY_DOMAINS];
    } catch (e) { /* fall through to detection */ }

    if (patterns.some(p => snafHostMatchesPattern(hostname, p))) return true;

    return snafLooksLikeServiceNow(document, location);
}

// ── Visibility ────────────────────────────────────────────────────────────────
function paintVisibility() {
    host.style.display = visible ? '' : 'none';
    elPanel.classList.toggle('is-open', visible && !minimized);
    elPill.classList.toggle('is-open',  visible && minimized);
}

function saveUi() {
    const patch = {};
    patch[SNAF_KEY_UI] = {
        visible:   visible,
        minimized: minimized,
        left:      host.style.left   || '',
        top:       host.style.top    || ''
    };
    chrome.storage.local.set(patch).catch(() => {});
}

function showWidget()  { visible = true;  minimized = false; paintVisibility(); saveUi(); }
function hideWidget()  { visible = false; paintVisibility(); saveUi(); }
function minimise()    { minimized = true;  paintVisibility(); saveUi(); }
function expand()      { minimized = false; paintVisibility(); saveUi(); }

// Minimise and close are explicit controls. The header itself is only a drag
// handle — clicking it must never collapse the panel, which is what made the
// old widget feel like it was toggling at random.
elMin.addEventListener('click', e => { e.stopPropagation(); minimise(); });
elClose.addEventListener('click', e => { e.stopPropagation(); hideWidget(); });

elPill.addEventListener('click', expand);
elPill.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); expand(); }
});

elConfig.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_CONFIG', section: 'groups' }).catch(() => {});
});

// ── Dragging ──────────────────────────────────────────────────────────────────
// Bottom/right anchored by default; the first drag switches to top/left and
// clamps inside the viewport so the widget can't be lost off-screen.
let dragging = false;
let dragDX   = 0;
let dragDY   = 0;

elHead.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (e.target.closest('#snaf-head-btns')) return;
    const rect = host.getBoundingClientRect();
    dragging = true;
    dragDX   = e.clientX - rect.left;
    dragDY   = e.clientY - rect.top;
    elHead.classList.add('is-dragging');
    e.preventDefault();
});

document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const rect = host.getBoundingClientRect();
    const maxX = Math.max(0, window.innerWidth  - rect.width);
    const maxY = Math.max(0, window.innerHeight - rect.height);
    host.style.left   = Math.min(maxX, Math.max(0, e.clientX - dragDX)) + 'px';
    host.style.top    = Math.min(maxY, Math.max(0, e.clientY - dragDY)) + 'px';
    host.style.right  = 'auto';
    host.style.bottom = 'auto';
});

document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    elHead.classList.remove('is-dragging');
    saveUi();
});

// ── Engine state painting ─────────────────────────────────────────────────────
function activeGroupCount() {
    return groups.filter(g => g && g.active !== false).length;
}

function paintStats() {
    elSession.textContent = sessionCount;
    elTotal.textContent   = totalCount;
    elGroups.textContent  = activeGroupCount();
    elCycles.textContent  = cycleCount;
}

function setEngine(state) {
    engine = state;

    const label = state === 'running' ? 'Running' : state === 'paused' ? 'Paused' : 'Stopped';
    elDot.className = state === 'running' ? 'running' : state === 'paused' ? 'paused' : '';

    const scopeName = scopeId
        ? (groups.find(g => g.id === scopeId) || {}).name || 'one group'
        : snafPlural(activeGroupCount(), 'group');

    elPillState.textContent = label;
    elHeadState.textContent = label + ' · ' + scopeName;

    elStart.style.display = state === 'stopped' ? '' : 'none';
    elPause.style.display = state === 'stopped' ? 'none' : '';
    elStop.style.display  = state === 'stopped' ? 'none' : '';

    // Rebuilt from static strings rather than swapping the SVG via outerHTML,
    // which behaves inconsistently for foreign-content elements.
    const paused = state === 'paused';
    elPause.innerHTML = (paused ? SVG.play : SVG.pause) +
                        '<span>' + (paused ? 'Resume' : 'Pause') + '</span>';

    if (state === 'stopped') {
        elPillTimer.textContent = '';
        elTimerVal.textContent  = '—';
        elFill.style.width      = '100%';
    }
    syncKeepAlive();
}

// ── Countdown ─────────────────────────────────────────────────────────────────
function startCountdown(onDone) {
    intervalSecs = snafClampInt(elInterval.value, 15, 3600, 60);
    remainingMs  = intervalSecs * 1000;
    clearInterval(tickTimer);

    tickTimer = setInterval(() => {
        if (engine === 'paused') return;
        if (engine === 'stopped') { clearInterval(tickTimer); tickTimer = null; return; }

        remainingMs -= 1000;
        const secs = Math.max(0, Math.round(remainingMs / 1000));
        const mins = Math.floor(secs / 60);
        const text = mins > 0 ? mins + ':' + String(secs % 60).padStart(2, '0') : secs + 's';

        elTimerVal.textContent  = text;
        elPillTimer.textContent = text;
        elFill.style.width      = Math.max(0, (remainingMs / (intervalSecs * 1000)) * 100) + '%';

        if (remainingMs <= 0) {
            clearInterval(tickTimer);
            tickTimer = null;
            if (engine === 'running') onDone();
        }
    }, 1000);
}

// ── ServiceNow API ────────────────────────────────────────────────────────────
async function getToken() {
    if (token) return token;
    if (tokenTried) return null;
    tokenTried = true;
    try {
        const res = await chrome.runtime.sendMessage({ type: 'READ_TOKEN' });
        if (res && res.ok && res.token) token = res.token;
    } catch (e) { /* fall through — GETs generally still work on cookie auth */ }
    return token;
}

async function apiFetch(method, path, body) {
    const tk      = await getToken();
    const headers = { 'Accept': 'application/json' };
    if (tk) headers['X-UserToken'] = tk;
    if (body) headers['Content-Type'] = 'application/json';

    const res = await fetch(location.origin + path, {
        method:      method,
        headers:     headers,
        credentials: 'same-origin',
        cache:       'no-store',
        body:        body ? JSON.stringify(body) : undefined
    });

    if (res.status === 401 || res.status === 403) {
        // The token may simply have rotated. Drop it so the next call re-reads.
        token = null;
        tokenTried = false;
        throw new Error('HTTP ' + res.status + ' — not authorised');
    }

    // A lapsed session answers with the login page, not JSON. Detect that rather
    // than surfacing a confusing JSON parse error.
    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('json')) {
        if (res.redirected || res.ok) {
            throw new Error('Session expired — reload the ServiceNow tab and sign in');
        }
        throw new Error('HTTP ' + res.status);
    }

    if (!res.ok) {
        let detail = '';
        try {
            const j = await res.json();
            detail = (j && j.error && (j.error.message || j.error.detail)) || '';
        } catch (e) {}
        throw new Error('HTTP ' + res.status + (detail ? ' — ' + detail : ''));
    }

    const json = await res.json();
    return json ? json.result : null;
}

function apiGet(path)          { return apiFetch('GET', path); }
function apiPatch(path, body)  { return apiFetch('PATCH', path, body); }

// ── User lookup ───────────────────────────────────────────────────────────────
const USER_FIELDS = 'sys_id,name,user_name,email';

// Resolves ServiceNow user IDs to sys_ids. Terms without a comma are batched
// into one `user_nameIN` query; anything left unmatched falls back to a per-term
// query that also considers the display name and the email address.
async function lookupUsers(terms) {
    const wanted = [];
    const seen   = Object.create(null);
    (terms || []).forEach(t => {
        const v = String(t || '').trim();
        if (!v) return;
        const k = v.toLowerCase();
        if (seen[k]) return;
        seen[k] = true;
        wanted.push(v);
    });
    if (!wanted.length) return {};

    const found = Object.create(null);

    const batchable = wanted.filter(t => t.indexOf(',') === -1);
    if (batchable.length) {
        const q = 'user_nameIN' + batchable.join(',');
        try {
            const rows = await apiGet(
                '/api/now/table/sys_user?sysparm_query=' + encodeURIComponent(q) +
                '&sysparm_fields=' + USER_FIELDS +
                '&sysparm_limit=' + Math.max(50, batchable.length * 2)
            ) || [];
            rows.forEach(r => {
                const key = String(r.user_name || '').toLowerCase();
                if (key) found[key] = r;
            });
        } catch (e) { /* fall through to the per-term path */ }
    }

    const unresolved = wanted.filter(t => !found[t.toLowerCase()]);
    // Bounded so a badly configured group can't fire off hundreds of requests.
    for (const term of unresolved.slice(0, 25)) {
        try {
            const rows = await apiGet(
                '/api/now/table/sys_user?sysparm_query=' + encodeURIComponent(snafUserQuery('name', term)) +
                '&sysparm_fields=' + USER_FIELDS + '&sysparm_limit=2'
            ) || [];
            // Exactly one match, or the lookup is ambiguous and must not guess.
            if (rows.length === 1) found[term.toLowerCase()] = rows[0];
            else if (rows.length > 1) found[term.toLowerCase()] = { __ambiguous: true, count: rows.length };
        } catch (e) { /* reported by the caller */ }
    }

    return found;
}

async function saveDirectory() {
    const patch = {};
    patch[SNAF_KEY_USERS] = directory;
    return chrome.storage.local.set(patch);
}

// Resolution results are written back into the directory so the same lookup is
// never paid for twice, and so the Agents panel fills itself in as you use the
// engine.
function rememberUser(row) {
    if (!row || !row.sys_id) return;
    const merged = snafMergeUsers(directory, [{
        name:      row.name,
        user_name: row.user_name,
        sys_id:    row.sys_id,
        email:     row.email
    }]);
    directory = merged.users;
    return merged.added || merged.updated;
}

// Turns a group's agent rows into a list the round robin can use, resolving any
// that were configured by user ID. Rows that cannot be resolved are reported
// once and then skipped, so one bad entry never stalls a group.
async function prepareAgents(g) {
    const rows    = (g.agents || []).filter(a => a && a.active !== false);
    const ready   = [];
    const pending = [];

    rows.forEach(a => {
        const hint = snafResolveHint(a);
        if (hint.mode === 'ready') {
            ready.push({ agent: a, sys_id: hint.sys_id, label: a.name || a.user_name || hint.sys_id });
            return;
        }
        if (hint.mode === 'invalid') {
            log('skipped an agent row: ' + hint.reason, 'warn', true);
            return;
        }
        // Try the local directory before going to the network.
        const hit = snafFindUser(directory, hint.term);
        if (hit && hit.sys_id) {
            ready.push({ agent: a, sys_id: hit.sys_id, label: a.name || hit.name || hint.term });
            return;
        }
        pending.push({ agent: a, hint: hint });
    });

    if (pending.length && settings.rules.resolveUserIds) {
        log('resolving ' + snafPlural(pending.length, 'user ID') + '…', 'dim', true);
        let map = {};
        try {
            map = await lookupUsers(pending.map(p => p.hint.term));
        } catch (e) {
            log('user lookup failed: ' + e.message, 'err', true);
        }

        let learned = 0;
        pending.forEach(p => {
            const row = map[p.hint.term.toLowerCase()];
            if (!row) {
                log('no ServiceNow user matches "' + p.hint.term + '"', 'err', true);
                return;
            }
            if (row.__ambiguous) {
                log('"' + p.hint.term + '" matches ' + row.count + ' users — use the exact user ID or a sys_id', 'err', true);
                return;
            }
            if (rememberUser(row)) learned++;
            // Cache on the agent row too, so a later run needs no lookup at all.
            p.agent.sys_id = row.sys_id;
            if (!p.agent.user_name && row.user_name) p.agent.user_name = row.user_name;
            if (!p.agent.name && row.name) p.agent.name = row.name;
            ready.push({ agent: p.agent, sys_id: row.sys_id, label: p.agent.name || row.name || p.hint.term });
        });

        if (learned) {
            await saveDirectory().catch(() => {});
            await saveGroups().catch(() => {});
            log('added ' + snafPlural(learned, 'user') + ' to the global directory', 'ok', true);
        }
    } else if (pending.length) {
        pending.forEach(p => log('"' + p.hint.term + '" has no sys_id and user-ID resolution is off', 'warn', true));
    }

    // Preserve the configured order — round robin fairness depends on it.
    const order = new Map();
    rows.forEach((a, i) => order.set(a, i));
    ready.sort((x, y) => (order.get(x.agent) || 0) - (order.get(y.agent) || 0));
    return ready;
}

// ── Round robin ───────────────────────────────────────────────────────────────
async function getRR(groupId) {
    const store = await chrome.storage.local.get(SNAF_KEY_RR);
    const rr    = store[SNAF_KEY_RR] || {};
    return rr[groupId] || 0;
}

async function setRR(groupId, idx) {
    const store = await chrome.storage.local.get(SNAF_KEY_RR);
    const rr    = store[SNAF_KEY_RR] || {};
    rr[groupId] = idx;
    const patch = {};
    patch[SNAF_KEY_RR] = rr;
    return chrome.storage.local.set(patch);
}

// Walks forward from the round-robin cursor to the next agent still under the
// per-cycle cap. Returns null when every agent is capped.
function pickAgent(agents, cursor, perAgent, cap) {
    for (let i = 0; i < agents.length; i++) {
        const idx = (cursor + i) % agents.length;
        const a   = agents[idx];
        if (!cap || (perAgent[a.sys_id] || 0) < cap) return { pick: a, next: idx + 1 };
    }
    return null;
}

async function saveGroups() {
    const patch = {};
    patch[SNAF_KEY_GROUPS] = groups;
    return chrome.storage.local.set(patch);
}

async function saveStats() {
    const patch = {};
    patch[SNAF_KEY_STATS] = { totalAssigned: totalCount, cyclesRun: cycleCount };
    return chrome.storage.local.set(patch);
}

// ── Cycle ─────────────────────────────────────────────────────────────────────
async function processGroup(g, ctx) {
    const rules = settings.rules;
    const table = (g.table || rules.defaultTable || 'incident').trim();

    log(g.name || 'Unnamed group', 'head');

    let query = String(g.query || '');
    if (rules.requireUnassigned) {
        const guarded = snafEnsureUnassigned(query);
        if (guarded !== query) log('added assigned_toISEMPTY to the query', 'dim', true);
        query = guarded;
    }

    let tickets;
    try {
        tickets = await apiGet(
            '/api/now/table/' + encodeURIComponent(table) +
            '?sysparm_query=' + encodeURIComponent(query) +
            '&sysparm_fields=sys_id,number&sysparm_limit=' + SNAF_FETCH_LIMIT
        );
    } catch (e) {
        log('could not read ' + table + ': ' + e.message, 'err', true);
        return 0;
    }

    if (!tickets || !tickets.length) {
        log('nothing to assign', 'dim', true);
        return 0;
    }
    log(snafPlural(tickets.length, 'ticket') + ' matched', 'dim', true);

    const agents = await prepareAgents(g);
    if (!agents.length) {
        log('no usable agents — nothing assigned', 'warn', true);
        return 0;
    }

    let cursor  = await getRR(g.id);
    let done    = 0;
    const dry   = !!rules.dryRun;

    for (const ticket of tickets) {
        if (engine !== 'running') { log('stopped mid-group', 'warn', true); break; }

        if (rules.maxPerCycle && ctx.assigned >= rules.maxPerCycle) {
            log('cycle cap of ' + rules.maxPerCycle + ' reached', 'warn', true);
            break;
        }

        const chosen = pickAgent(agents, cursor, ctx.perAgent, rules.maxPerAgentPerCycle);
        if (!chosen) {
            log('every agent is at the per-cycle cap', 'warn', true);
            break;
        }

        const label = chosen.pick.label;
        const num   = ticket.number || ticket.sys_id;

        if (dry) {
            // Dry run advances a local cursor so the preview reflects real
            // ordering, but writes nothing and counts nothing.
            cursor = chosen.next;
            log(num + ' would go to ' + label, 'dim', true);
            continue;
        }

        let ok = false;
        let err = '';
        try {
            await apiPatch('/api/now/table/' + encodeURIComponent(table) + '/' + encodeURIComponent(ticket.sys_id),
                           { assigned_to: chosen.pick.sys_id });
            ok = true;
        } catch (e) { err = e.message; }

        if (ok) {
            cursor = chosen.next;
            ctx.assigned++;
            ctx.perAgent[chosen.pick.sys_id] = (ctx.perAgent[chosen.pick.sys_id] || 0) + 1;
            done++;
            log(num + ' → ' + label, 'ok', true);
        } else {
            log(num + ' failed: ' + err, 'err', true);
            // A session problem will hit every remaining ticket, so stop early.
            if (/session expired|not authorised/i.test(err)) {
                log('halting this group', 'err', true);
                break;
            }
        }
    }

    if (!dry) await setRR(g.id, cursor).catch(() => {});
    return done;
}

async function runCycle() {
    if (engine !== 'running') return;

    let scope = groups.filter(snafGroupIsRunnable);
    if (scopeId) scope = scope.filter(g => g.id === scopeId);

    if (!scope.length) {
        log('no runnable groups — check the configuration', 'warn');
        startCountdown(runCycle);
        return;
    }

    cycleCount++;
    paintStats();
    log('Cycle ' + cycleCount + ' · ' + snafPlural(scope.length, 'group'), 'head');

    const ctx = { assigned: 0, perAgent: Object.create(null) };

    for (const g of scope) {
        if (engine !== 'running') break;
        if (settings.rules.maxPerCycle && ctx.assigned >= settings.rules.maxPerCycle) break;
        try { await processGroup(g, ctx); }
        catch (e) { log((g.name || 'group') + ': ' + e.message, 'err'); }
    }

    sessionCount += ctx.assigned;
    totalCount   += ctx.assigned;

    await saveStats().catch(() => {});
    paintStats();

    if (settings.rules.dryRun) log('Dry run complete — nothing was written', 'warn');
    else log('Cycle complete · ' + snafPlural(ctx.assigned, 'assignment'), ctx.assigned ? 'ok' : 'dim');

    flushLogs();
    if (engine === 'running') startCountdown(runCycle);
}

// ── Keep-alive ────────────────────────────────────────────────────────────────
// The session must not lapse while the engine is waiting between cycles, so
// keep-alive is forced on whenever the engine is not stopped, whatever the
// toggle says. Requests go to this instance only and nothing is read from them.
let kaTimer = null;
let kaIdx   = 0;
let kaOn    = false;

function kaPing() {
    const endpoint = SNAF_KEEPALIVE_ENDPOINTS[kaIdx];
    fetch(location.origin + endpoint, {
        method: 'GET', credentials: 'same-origin', cache: 'no-store'
    }).then(res => {
        if (!res.ok) kaIdx = (kaIdx + 1) % SNAF_KEEPALIVE_ENDPOINTS.length;
    }).catch(() => {
        kaIdx = (kaIdx + 1) % SNAF_KEEPALIVE_ENDPOINTS.length;
    });
}

function keepAliveWanted() {
    // Never ping a page that isn't an instance. Under an all-sites grant this
    // script runs everywhere, and requesting /api/now/session on an unrelated
    // site would be pointless traffic against somebody else's server.
    if (snTrusted !== true) return false;
    if (engine !== 'stopped' && settings.keepAlive.forceWhileRunning) return true;
    return !!settings.keepAlive.enabled;
}

function syncKeepAlive() {
    const want = keepAliveWanted();

    if (!want) {
        if (kaTimer) { clearInterval(kaTimer); kaTimer = null; }
        kaOn = false;
        elKa.classList.remove('is-on');
        return;
    }

    const period = snafClampInt(settings.keepAlive.minutes,
        SNAF_KEEPALIVE_MIN_MINUTES, SNAF_KEEPALIVE_MAX_MINUTES,
        SNAF_KEEPALIVE_DEFAULT_MINUTES) * 60000;

    // Re-armed from scratch so an interval change takes effect immediately.
    if (kaTimer) clearInterval(kaTimer);
    kaTimer = setInterval(kaPing, period);
    elKa.classList.add('is-on');

    // Only ping straight away on the off → on transition, not on every repaint.
    if (!kaOn) { kaOn = true; kaPing(); }
}

// A session that is going to lapse does it while the tab sits in the
// background, so returning to the tab is exactly when a ping is worth making.
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && keepAliveWanted()) kaPing();
});

// ── Controls ──────────────────────────────────────────────────────────────────
elStart.addEventListener('click', () => {
    if (snTrusted !== true) {
        log('this page is not a recognised ServiceNow instance — add its domain under Settings → Instances', 'err');
        return;
    }
    const runnable = groups.filter(snafGroupIsRunnable);
    if (!runnable.length) {
        log('nothing to run — open the configuration and add a group with agents', 'warn');
        return;
    }
    if (scopeId && !runnable.some(g => g.id === scopeId)) {
        log('the selected group is not runnable — pick another scope', 'warn');
        return;
    }
    sessionCount = 0;
    setEngine('running');
    paintStats();
    log('Engine started' + (settings.rules.dryRun ? ' in dry-run mode' : ''), 'ok');
    runCycle();
});

elPause.addEventListener('click', () => {
    if (engine === 'running')     { setEngine('paused');  log('Paused', 'warn'); }
    else if (engine === 'paused') { setEngine('running'); log('Resumed', 'ok'); }
});

elStop.addEventListener('click', () => {
    clearInterval(tickTimer);
    tickTimer   = null;
    remainingMs = 0;
    setEngine('stopped');
    log('Engine stopped', 'warn');
    flushLogs();
});

elScope.addEventListener('change', () => {
    scopeId = elScope.value || null;
    setEngine(engine);
});

elInterval.addEventListener('change', () => {
    intervalSecs = snafClampInt(elInterval.value, 15, 3600, 60);
    log('Interval set to ' + intervalLabel(intervalSecs), 'dim');
});

// ── State load ────────────────────────────────────────────────────────────────
function rebuildScope() {
    while (elScope.options.length > 1) elScope.remove(1);
    groups.filter(g => g && g.active !== false).forEach(g => {
        const o = document.createElement('option');
        o.value       = g.id;
        o.textContent = g.name || 'Unnamed group';
        elScope.appendChild(o);
    });
    // Drop a scope that no longer exists rather than silently running everything.
    if (scopeId && !groups.some(g => g.id === scopeId)) scopeId = null;
    elScope.value = scopeId || '';
}

async function loadState(firstRun) {
    const store = await chrome.storage.local.get([
        SNAF_KEY_GROUPS, SNAF_KEY_STATS, SNAF_KEY_SETTINGS, SNAF_KEY_USERS, SNAF_KEY_UI
    ]);

    groups    = Array.isArray(store[SNAF_KEY_GROUPS]) ? store[SNAF_KEY_GROUPS] : [];
    settings  = snafNormaliseSettings(store[SNAF_KEY_SETTINGS]);
    directory = snafNormaliseUsers(store[SNAF_KEY_USERS]);

    // Re-resolved on every load, not just the first: the page may have finished
    // rendering its shell since, which is what the detection heuristic reads.
    snTrusted = await resolveTrust();

    const stats = store[SNAF_KEY_STATS] || {};
    totalCount  = stats.totalAssigned || 0;
    if (firstRun) cycleCount = stats.cyclesRun || 0;

    intervalSecs  = snafClampInt(settings.rules.defaultIntervalSecs, 15, 3600, 60);
    // Snap to the nearest offered step so the select always shows a real value.
    const nearest = SNAF_INTERVAL_STEPS.reduce((best, s) =>
        Math.abs(s - intervalSecs) < Math.abs(best - intervalSecs) ? s : best, SNAF_INTERVAL_STEPS[0]);
    elInterval.value = String(nearest);

    rebuildScope();
    paintStats();
    refreshNotice();

    if (firstRun) {
        const ui = store[SNAF_KEY_UI] || {};
        visible   = !!ui.visible;
        minimized = !!ui.minimized;
        if (ui.left && ui.top) {
            host.style.left   = ui.left;
            host.style.top    = ui.top;
            host.style.right  = 'auto';
            host.style.bottom = 'auto';
        }
        paintVisibility();
        setEngine('stopped');
        if (visible) log('Ready on ' + location.hostname, 'dim');
    } else {
        setEngine(engine);
    }

    syncKeepAlive();
}

// ── Messages ──────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;

    switch (msg.type) {
        case 'PING':
            sendResponse({ ok: true, visible: visible, engine: engine });
            return false;

        case 'TOGGLE_WIDGET':
            if (visible) hideWidget();
            else { showWidget(); if (!elLog.children.length) log('Ready on ' + location.hostname, 'dim'); }
            sendResponse({ ok: true, visible: visible });
            return false;

        case 'QUERY_STATE':
            sendResponse({
                ok: true, visible: visible, minimized: minimized, engine: engine,
                host: location.hostname, session: sessionCount,
                total: totalCount, groups: activeGroupCount()
            });
            return false;

        case 'RELOAD_STATE':
            loadState(false)
                .then(() => { log('Configuration reloaded', 'dim'); sendResponse({ ok: true }); })
                .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
            return true;

        // The configuration page has no ServiceNow session of its own, so it
        // borrows this tab to resolve user IDs against the instance.
        case 'RESOLVE_USERS':
            lookupUsers(msg.terms || [])
                .then(map => {
                    const out = {};
                    Object.keys(map).forEach(k => {
                        const r = map[k];
                        out[k] = r && r.__ambiguous
                            ? { ambiguous: true, count: r.count }
                            : { name: r.name, user_name: r.user_name, sys_id: r.sys_id, email: r.email };
                    });
                    sendResponse({ ok: true, users: out, host: location.hostname });
                })
                .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
            return true;

        default:
            return false;
    }
});

// Storage is the single source of truth, so a change made anywhere — the
// configuration page, another tab — lands here without an explicit broadcast.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[SNAF_KEY_SETTINGS]) {
        settings = snafNormaliseSettings(changes[SNAF_KEY_SETTINGS].newValue);
        refreshNotice();
        syncKeepAlive();
    }
    if (changes[SNAF_KEY_USERS]) {
        directory = snafNormaliseUsers(changes[SNAF_KEY_USERS].newValue);
    }
});

window.addEventListener('pagehide', flushLogs);

loadState(true).catch(e => {
    // Nothing else will work without state, so make the failure visible.
    log('could not load configuration: ' + (e && e.message || e), 'err');
});

})();
