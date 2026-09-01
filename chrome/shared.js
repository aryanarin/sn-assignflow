'use strict';

// SN Assignflow — shared definitions
//
// Loaded by the content script (before widget.js), by popup.html and by
// config.html. Everything here is either a constant or a pure function, so the
// same file is safe in all three contexts. Declarations use `var`/`function` at
// top level on purpose: content scripts are classic scripts, not modules.

// ── Storage keys ──────────────────────────────────────────────────────────────
// The first four keys are inherited from AssignFlow 3.x so an existing
// configuration survives the upgrade untouched.
var SNAF_KEY_GROUPS   = 'snDispatcherGroups';
var SNAF_KEY_STATS    = 'snDispatcherStats';
var SNAF_KEY_RR       = 'snDispatcherRR';
var SNAF_KEY_THEME    = 'snDispatcherTheme';
var SNAF_KEY_USERS    = 'snafUsers';
var SNAF_KEY_SETTINGS = 'snafSettings';
var SNAF_KEY_LOGS     = 'snafLogs';
// Widget placement and open/minimised state, so a ServiceNow navigation doesn't
// throw the widget away. Local to the machine and never part of an export.
var SNAF_KEY_UI       = 'snafUi';
// Instances the user has granted access to beyond the built-in cloud pattern.
// SNAF_KEY_DOMAINS holds match patterns ('*://host/*'); SNAF_KEY_ALLURLS is the
// broad opt-in. Both are permission bookkeeping, never part of an export.
var SNAF_KEY_DOMAINS  = 'snafCustomDomains';
var SNAF_KEY_ALLURLS  = 'snafAllUrls';

var SNAF_EXPORT_VERSION = '4.0';

// ── Instance hosts ────────────────────────────────────────────────────────────
// Only ServiceNow's own cloud domain is built in. Anything else — an on-premise
// deployment, a vanity domain, a reverse proxy — is added by the user at
// runtime through Settings → Instances, which requests the host permission at
// that moment. No customer or employer domain is ever shipped in the manifest.
var SNAF_CLOUD_PATTERN = '*://*.service-now.com/*';
var SNAF_ALL_URLS      = '<all_urls>';

// Identifier for the dynamically registered content script. Registering under a
// fixed id means a re-sync replaces the previous registration instead of
// stacking duplicates.
var SNAF_DYNAMIC_SCRIPT_ID = 'snaf-dynamic';

// Files the dynamic registration injects. Must stay in step with
// content_scripts in both manifests.
var SNAF_CONTENT_JS  = ['shared.js', 'widget.js'];
var SNAF_CONTENT_CSS = ['widget.css'];

function snafIsServiceNowCloud(host) {
    return /(?:^|\.)service-now\.com$/i.test(String(host || '').trim());
}

// 'https://sn.example.com/nav_to.do' and 'sn.example.com:8443' both become
// '*://sn.example.com/*'. Returns null when nothing usable is left.
function snafDomainToPattern(raw) {
    let host = String(raw || '').trim();
    if (!host) return null;
    host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');   // strip a pasted scheme
    host = host.split('/')[0];                              // strip any path
    host = host.split('?')[0];
    host = host.split('#')[0];
    host = host.split('@').pop();                           // strip credentials
    host = host.split(':')[0];                              // strip any port
    host = host.trim().toLowerCase();
    if (!host) return null;
    // A bare label like "localhost" is legitimate; anything with whitespace or
    // an obviously invalid character is not.
    if (!/^[a-z0-9.*-]+$/.test(host)) return null;
    if (host === '*' || host === '*.') return null;
    return '*://' + host + '/*';
}

function snafPatternToDomain(pattern) {
    return String(pattern || '').replace(/^\*:\/\//, '').replace(/\/\*$/, '');
}

// Match a hostname against one of our stored patterns. Only the '*.' prefix
// form is supported, which is all snafDomainToPattern can produce.
function snafHostMatchesPattern(host, pattern) {
    const h = String(host || '').trim().toLowerCase();
    const p = snafPatternToDomain(pattern).toLowerCase();
    if (!h || !p) return false;
    if (p === h) return true;
    if (p.indexOf('*.') === 0) {
        const base = p.slice(2);
        return h === base || h.endsWith('.' + base);
    }
    return false;
}

function snafHostAllowed(host, patterns) {
    if (snafIsServiceNowCloud(host)) return true;
    if (!Array.isArray(patterns)) return false;
    return patterns.some(p => snafHostMatchesPattern(host, p));
}

// Best-effort "is this page actually a ServiceNow instance?" check, for the case
// where the user granted access to all sites rather than naming their instance.
// Granting <all_urls> is a convenience, not a claim that every site is
// ServiceNow, so behaviour that touches the network — the keep-alive ping in
// particular — is gated on this rather than on the permission alone.
//
// Deliberately cheap and synchronous: DOM and cookie markers only, no probing.
function snafLooksLikeServiceNow(doc, loc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    const l = loc || (typeof location !== 'undefined' ? location : null);
    if (!d || !l) return false;

    if (snafIsServiceNowCloud(l.hostname)) return true;

    // Classic UI renders the whole application inside this frame.
    if (d.getElementById('gsft_main')) return true;
    // Present on every classic form as the CSRF token field.
    if (d.querySelector('input[name="sysparm_ck"]')) return true;
    // Now Experience / UI16 shells.
    if (d.querySelector('sn-application-shell, [ng-app="glide"], [data-sn-app], #sn_appshell')) return true;
    // Instance-set routing cookies. Not HttpOnly, so readable here.
    if (/(?:^|;\s*)glide_/.test(d.cookie || '')) return true;
    // Serving paths unique enough to be worth trusting.
    if (/\/(?:nav_to|home|welcome|stats|login)\.do\b/.test(l.pathname || '')) return true;
    if (/^\/(?:now|sp|esc|api\/now)\//.test(l.pathname || '')) return true;

    return false;
}

// ── Session keep-alive ────────────────────────────────────────────────────────
// Instance-relative on purpose: each tab pings its own instance and nothing
// else. Tried in order — on a non-OK response or a network error the next one
// is used for the following ping, because instances differ in what they expose.
var SNAF_KEEPALIVE_ENDPOINTS       = ['/api/now/session', '/now/nav/header', '/stats.do'];
var SNAF_KEEPALIVE_DEFAULT_MINUTES = 2;
var SNAF_KEEPALIVE_MIN_MINUTES     = 1;
var SNAF_KEEPALIVE_MAX_MINUTES     = 60;

// ── Misc limits ───────────────────────────────────────────────────────────────
var SNAF_LOG_LIMIT      = 500;   // persisted log ring buffer
var SNAF_FETCH_LIMIT    = 500;   // max tickets pulled per group per cycle
var SNAF_INTERVAL_STEPS = [30, 60, 120, 300, 600, 1800];

// ── Small utilities ───────────────────────────────────────────────────────────
function snafUid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function snafClampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function snafIsSysId(value) {
    return typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value.trim());
}

// A ServiceNow user_name. Deliberately permissive — instances use employee
// numbers, email-shaped logins and plain names. Anything with a space is
// treated as a display name instead.
function snafLooksLikeUserId(value) {
    if (typeof value !== 'string') return false;
    const v = value.trim();
    if (!v || v.length > 100) return false;
    if (/\s/.test(v)) return false;
    return !snafIsSysId(v);
}

// snafPlural(1, 'agent') === '1 agent'; snafPlural(2, 'agent') === '2 agents'
// snafPlural(2, 'person', 'people') === '2 people'
function snafPlural(n, singular, plural) {
    return n + ' ' + (n === 1 ? singular : (plural || singular + 's'));
}

function snafTimestamp(date) {
    const d = date || new Date();
    return d.toLocaleTimeString('en-GB', { hour12: false });
}

function snafDateStamp(date) {
    const d = date || new Date();
    const p = n => (n < 10 ? '0' : '') + n;
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// ── Settings ──────────────────────────────────────────────────────────────────
function snafDefaultSettings() {
    return {
        keepAlive: {
            enabled: true,
            minutes: SNAF_KEEPALIVE_DEFAULT_MINUTES,
            // While the engine is running the session must not lapse, so
            // keep-alive is forced on regardless of the toggle above.
            forceWhileRunning: true
        },
        rules: {
            dryRun:              false,
            requireUnassigned:   true,
            maxPerCycle:         0,   // 0 = no cap
            maxPerAgentPerCycle: 0,   // 0 = no cap
            resolveUserIds:      true,
            defaultTable:        'incident',
            defaultIntervalSecs: 60
        },
        logs: { persist: true }
    };
}

function snafNormaliseSettings(raw) {
    const out = snafDefaultSettings();
    if (!raw || typeof raw !== 'object') return out;

    const ka = raw.keepAlive;
    if (ka && typeof ka === 'object') {
        if (typeof ka.enabled === 'boolean') out.keepAlive.enabled = ka.enabled;
        out.keepAlive.minutes = snafClampInt(
            ka.minutes, SNAF_KEEPALIVE_MIN_MINUTES, SNAF_KEEPALIVE_MAX_MINUTES,
            SNAF_KEEPALIVE_DEFAULT_MINUTES
        );
        if (typeof ka.forceWhileRunning === 'boolean') {
            out.keepAlive.forceWhileRunning = ka.forceWhileRunning;
        }
    }

    const r = raw.rules;
    if (r && typeof r === 'object') {
        if (typeof r.dryRun === 'boolean')            out.rules.dryRun = r.dryRun;
        if (typeof r.requireUnassigned === 'boolean') out.rules.requireUnassigned = r.requireUnassigned;
        if (typeof r.resolveUserIds === 'boolean')    out.rules.resolveUserIds = r.resolveUserIds;
        out.rules.maxPerCycle         = snafClampInt(r.maxPerCycle, 0, 10000, 0);
        out.rules.maxPerAgentPerCycle = snafClampInt(r.maxPerAgentPerCycle, 0, 10000, 0);
        if (typeof r.defaultTable === 'string' && r.defaultTable.trim()) {
            out.rules.defaultTable = r.defaultTable.trim();
        }
        out.rules.defaultIntervalSecs = snafClampInt(r.defaultIntervalSecs, 15, 3600, 60);
    }

    if (raw.logs && typeof raw.logs === 'object' && typeof raw.logs.persist === 'boolean') {
        out.logs.persist = raw.logs.persist;
    }
    return out;
}

// ── Global user directory ─────────────────────────────────────────────────────
// A directory entry is the answer to "configure agents by user ID": the user ID
// is what you type, the sys_id is filled in once and then reused. Either field
// alone is enough for the engine to work — see snafResolveHint.
function snafNormaliseUser(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const name     = String(raw.name || raw.display_name || '').trim();
    const userName = String(raw.user_name || raw.userId || raw.user_id || raw.id || '').trim();
    const sysId    = String(raw.sys_id || '').trim();

    if (!name && !userName && !sysId) return null;

    return {
        uid:       String(raw.uid || snafUid()),
        name:      name,
        user_name: userName,
        sys_id:    snafIsSysId(sysId) ? sysId.toLowerCase() : '',
        email:     String(raw.email || '').trim(),
        note:      String(raw.note || '').trim(),
        addedAt:   raw.addedAt || new Date().toISOString()
    };
}

function snafNormaliseUsers(raw) {
    if (!Array.isArray(raw)) return [];
    const out  = [];
    const seen = Object.create(null);
    raw.forEach(item => {
        const u = snafNormaliseUser(item);
        if (!u) return;
        // De-duplicate on sys_id first, then on lowercased user ID.
        const key = u.sys_id ? 's:' + u.sys_id
                  : u.user_name ? 'u:' + u.user_name.toLowerCase()
                  : 'n:' + u.name.toLowerCase();
        if (seen[key]) {
            const prev = out[seen[key] - 1];
            if (!prev.name      && u.name)      prev.name      = u.name;
            if (!prev.user_name && u.user_name) prev.user_name = u.user_name;
            if (!prev.sys_id    && u.sys_id)    prev.sys_id    = u.sys_id;
            if (!prev.email     && u.email)     prev.email     = u.email;
            return;
        }
        out.push(u);
        seen[key] = out.length;
    });
    return out;
}

function snafUserLabel(u) {
    if (!u) return '';
    if (u.name && u.user_name) return u.name + ' (' + u.user_name + ')';
    return u.name || u.user_name || u.sys_id || '';
}

function snafInitials(value) {
    const v = String(value || '').trim();
    if (!v) return '?';
    const parts = v.split(/[\s._-]+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Deterministic so a given person keeps the same avatar tint across reloads.
function snafAvatarHue(seed) {
    const s = String(seed || '');
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    // Bias towards the violet half of the wheel so avatars sit inside the theme.
    return 215 + (h % 110);
}

// Ranked suggestion match: prefix hits beat substring hits, and the user ID is
// weighted above the display name because that's what people type.
function snafMatchUsers(users, term, limit) {
    const list = Array.isArray(users) ? users : [];
    const q    = String(term || '').trim().toLowerCase();
    const cap  = limit || 8;
    if (!q) return list.slice(0, cap);

    const scored = [];
    list.forEach(u => {
        const uname = (u.user_name || '').toLowerCase();
        const name  = (u.name || '').toLowerCase();
        const email = (u.email || '').toLowerCase();
        const sysId = (u.sys_id || '').toLowerCase();

        let score = -1;
        if (uname === q || sysId === q)          score = 0;
        else if (uname.indexOf(q) === 0)         score = 1;
        else if (name.indexOf(q) === 0)          score = 2;
        else if (email.indexOf(q) === 0)         score = 3;
        else if (uname.indexOf(q) > 0)           score = 4;
        else if (name.indexOf(q) > 0)            score = 5;
        else if (email.indexOf(q) > 0)           score = 6;
        else if (sysId.indexOf(q) === 0)         score = 7;

        if (score >= 0) scored.push({ u, score, label: snafUserLabel(u) });
    });

    scored.sort((a, b) => a.score - b.score || a.label.localeCompare(b.label));
    return scored.slice(0, cap).map(x => x.u);
}

// Exact-ish lookup used when an agent row references the directory by ID.
function snafFindUser(users, term) {
    const list = Array.isArray(users) ? users : [];
    const q    = String(term || '').trim().toLowerCase();
    if (!q) return null;
    return list.find(u => (u.sys_id || '').toLowerCase() === q)
        || list.find(u => (u.user_name || '').toLowerCase() === q)
        || list.find(u => (u.name || '').toLowerCase() === q)
        || list.find(u => (u.email || '').toLowerCase() === q)
        || null;
}

// Merge on identity rather than position, so re-importing a directory tops up
// missing sys_ids instead of creating duplicates.
function snafMergeUsers(existing, incoming) {
    const base  = snafNormaliseUsers(existing);
    const added = [];
    let updated = 0;

    snafNormaliseUsers(incoming).forEach(u => {
        const match = base.find(e =>
            (u.sys_id    && e.sys_id    && e.sys_id === u.sys_id) ||
            (u.user_name && e.user_name && e.user_name.toLowerCase() === u.user_name.toLowerCase())
        );
        if (!match) { base.push(u); added.push(u); return; }

        let touched = false;
        ['name', 'user_name', 'sys_id', 'email', 'note'].forEach(f => {
            if (u[f] && match[f] !== u[f]) { match[f] = u[f]; touched = true; }
        });
        if (touched) updated++;
    });

    return { users: base, added: added.length, updated: updated };
}

// Accepts a SN Assignflow export, a bare JSON array, or CSV with a header row.
function snafParseUserImport(text) {
    const raw = String(text || '').trim();
    if (!raw) throw new Error('File is empty');

    if (raw[0] === '{' || raw[0] === '[') {
        const data = JSON.parse(raw);
        const list = Array.isArray(data) ? data
                   : Array.isArray(data.users) ? data.users
                   : null;
        if (!list) throw new Error('No "users" array found');
        return snafNormaliseUsers(list);
    }
    return snafNormaliseUsers(snafParseUserCsv(raw));
}

// Quote-aware, because a display name like "Doe, Jane" is entirely normal and a
// naive split on commas silently truncates it. Embedded newlines are not
// supported — snafUsersToCsv flattens them on the way out instead.
function snafSplitCsvLine(line) {
    const out = [];
    let cur   = '';
    let inQ   = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQ) {
            if (ch !== '"') { cur += ch; continue; }
            if (line[i + 1] === '"') { cur += '"'; i++; }   // escaped quote
            else inQ = false;
        } else if (ch === '"') {
            inQ = true;
        } else if (ch === ',') {
            out.push(cur.trim());
            cur = '';
        } else {
            cur += ch;
        }
    }
    out.push(cur.trim());
    return out;
}

function snafParseUserCsv(text) {
    const lines = String(text).split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return [];

    const split  = snafSplitCsvLine;
    const header = split(lines[0]).map(h => h.toLowerCase().replace(/[^a-z_]/g, ''));

    // Both the header this tool writes (user_id) and the field name ServiceNow
    // itself uses (user_name) have to be understood, plus the obvious variants
    // people produce by hand or out of Excel.
    const aliases = {
        name: 'name', displayname: 'name', fullname: 'name', display_name: 'name', full_name: 'name',
        userid: 'user_name', user_id: 'user_name', user_name: 'user_name',
        username: 'user_name', login: 'user_name',
        sysid: 'sys_id', sys_id: 'sys_id',
        email: 'email', emailaddress: 'email', email_address: 'email',
        note: 'note', notes: 'note', comment: 'note'
    };

    const cols   = header.map(h => aliases[h] || null);
    const hasHdr = cols.some(Boolean);
    const rows   = hasHdr ? lines.slice(1) : lines;

    return rows.map(line => {
        const cells = split(line);
        if (!hasHdr) {
            // Positional fallback: name, user id, sys_id
            return { name: cells[0], user_name: cells[1], sys_id: cells[2] };
        }
        const obj = {};
        cols.forEach((key, i) => { if (key && cells[i]) obj[key] = cells[i]; });
        return obj;
    }).filter(o => o.name || o.user_name || o.sys_id);
}

function snafUsersToCsv(users) {
    const esc = v => {
        // Newlines are flattened rather than quoted: the parser reads one record
        // per line, so a genuine multi-line field could not be read back.
        const s = String(v == null ? '' : v).replace(/[\r\n]+/g, ' ');
        return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const head = 'name,user_id,sys_id,email,note';
    const body = snafNormaliseUsers(users).map(u =>
        [u.name, u.user_name, u.sys_id, u.email, u.note].map(esc).join(',')
    );
    return [head].concat(body).join('\n');
}

// ── Agent resolution ──────────────────────────────────────────────────────────
// An agent row on a group can carry a sys_id, a user ID, or just a name. This
// reports what the engine should do with it, without performing any I/O.
function snafResolveHint(agent) {
    if (!agent) return { mode: 'invalid', reason: 'Empty agent' };
    const sysId = String(agent.sys_id || '').trim();
    if (snafIsSysId(sysId)) return { mode: 'ready', sys_id: sysId.toLowerCase() };

    const userId = String(agent.user_name || '').trim();
    if (userId) return { mode: 'lookup', term: userId, field: 'user_name' };

    const name = String(agent.name || '').trim();
    if (!name) return { mode: 'invalid', reason: 'No user ID, sys_id or name' };
    if (snafIsSysId(name)) return { mode: 'ready', sys_id: name.toLowerCase() };
    // A bare token in the name slot is far more likely to be a login than a
    // display name, so try it as a user ID first and fall back to name matching.
    if (snafLooksLikeUserId(name)) return { mode: 'lookup', term: name, field: 'user_name' };
    return { mode: 'lookup', term: name, field: 'name' };
}

function snafUserQuery(field, term) {
    const t = String(term || '').trim();
    if (field === 'name') {
        return 'active=true^name=' + t + '^ORuser_name=' + t + '^OREmail=' + t;
    }
    return 'user_name=' + t + '^ORemail=' + t + '^ORname=' + t;
}

// ── Query helpers ─────────────────────────────────────────────────────────────
// Some SN URLs (/now/nav/ui/classic/params/target/...) are double- or
// triple-encoded. Keep decoding until the string stops changing.
function snafFullyDecode(str) {
    let prev = String(str == null ? '' : str);
    try {
        for (;;) {
            const next = decodeURIComponent(prev);
            if (next === prev) break;
            prev = next;
        }
    } catch (e) { /* malformed sequence — return what we have */ }
    return prev;
}

function snafExtractQuery(url) {
    try {
        const d = snafFullyDecode(url);
        const m = d.match(/sysparm_query=([^&]+)/);
        return m ? snafFullyDecode(m[1]) : null;
    } catch (e) { return null; }
}

function snafExtractTable(url) {
    try {
        const d = snafFullyDecode(url);
        let m = d.match(/[?&]target=([a-z0-9_]+)_list\.do/i);
        if (m) return m[1].toLowerCase();
        m = d.match(/\/([a-z0-9_]+)_list\.do/i);
        if (m) return m[1].toLowerCase();
        m = d.match(/\/now\/[a-z-]+\/list\/params\/list-id\/([a-z0-9_]+)/i);
        return m ? m[1].toLowerCase() : null;
    } catch (e) { return null; }
}

// Guard against a query that would re-assign already-assigned tickets. Only
// appended when the query doesn't already constrain assigned_to.
function snafEnsureUnassigned(query) {
    const q = String(query || '').trim();
    if (!q) return q;
    if (/assigned_to/i.test(q)) return q;
    return q + '^assigned_toISEMPTY';
}

function snafGroupIsRunnable(g) {
    return !!(g && g.active !== false && g.query &&
        Array.isArray(g.agents) && g.agents.some(a => a && a.active !== false));
}

function snafCountActiveAgents(g) {
    if (!g || !Array.isArray(g.agents)) return 0;
    return g.agents.filter(a => a && a.active !== false).length;
}
