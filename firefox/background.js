'use strict';

// SN Assignflow — background message router
//
// Runs as a service worker on Chrome and as an event page on Firefox, so it
// holds no state between messages: everything durable lives in chrome.storage,
// and the assignment engine itself lives in the content script where its timers
// survive as long as the tab does.
//
// shared.js is loaded differently in each browser, which is why the same file
// works as both: a classic service worker pulls it in with importScripts, while
// Firefox's event page lists it ahead of this file in background.scripts and the
// guard below is simply skipped. Either way SNAF_* is defined by the time
// anything runs.
if (typeof importScripts === 'function') importScripts('shared.js');

// ── Which hosts are ours ──────────────────────────────────────────────────────
// Only *.service-now.com is built in. Everything else was granted at runtime by
// the user through Settings → Instances, so the answer lives in storage and the
// permission store rather than in a constant.
//
// The granted list is read once and turned into a synchronous predicate, so a
// caller that has to test many tabs doesn't pay for a storage round trip each
// time.
async function snafGrantedHosts() {
    const store = await chrome.storage.local.get([SNAF_KEY_ALLURLS, SNAF_KEY_DOMAINS]);

    if (store[SNAF_KEY_ALLURLS]) {
        let has = false;
        try { has = await chrome.permissions.contains({ origins: [SNAF_ALL_URLS] }); }
        catch (e) { has = false; }
        // Stored preference but no live permission means it was revoked in the
        // browser's own UI. Fall through to the named domains rather than
        // pretending we still have it.
        if (has) return { all: true, patterns: [] };
    }

    const stored = Array.isArray(store[SNAF_KEY_DOMAINS]) ? store[SNAF_KEY_DOMAINS] : [];
    const kept   = [];
    for (const pattern of stored) {
        let has = false;
        try { has = await chrome.permissions.contains({ origins: [pattern] }); }
        catch (e) { has = false; }
        if (has) kept.push(pattern);
    }
    return { all: false, patterns: kept };
}

async function snafUrlMatcher() {
    const granted = await snafGrantedHosts();
    return function (url) {
        if (!url) return false;
        let u;
        try { u = new URL(url); } catch (e) { return false; }
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
        if (granted.all) return true;
        return snafHostAllowed(u.hostname, granted.patterns);
    };
}

// ── Dynamic content script ───────────────────────────────────────────────────
// The static content_scripts entry only covers *.service-now.com. For any host
// the user adds later, the same scripts are registered dynamically so the widget
// works there without shipping a new build.
async function snafSyncDynamicScript() {
    const granted  = await snafGrantedHosts();
    const patterns = granted.all ? [SNAF_ALL_URLS] : granted.patterns;

    try {
        const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SNAF_DYNAMIC_SCRIPT_ID] });
        if (existing && existing.length) {
            await chrome.scripting.unregisterContentScripts({ ids: [SNAF_DYNAMIC_SCRIPT_ID] });
        }
    } catch (e) { /* nothing registered yet */ }

    if (!patterns.length) return { ok: true, registered: 0 };

    try {
        await chrome.scripting.registerContentScripts([{
            id:      SNAF_DYNAMIC_SCRIPT_ID,
            matches: patterns,
            // shared.js first — widget.js is written against what it defines.
            js:      SNAF_CONTENT_JS,
            css:     SNAF_CONTENT_CSS,
            runAt:   'document_idle',
            persistAcrossSessions: true
        }]);
        return { ok: true, registered: patterns.length };
    } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
    }
}

// ── Content-script availability ───────────────────────────────────────────────
// A tab that was already open when the extension was installed, updated, or
// granted a new host has no content script in it. Rather than telling the user
// to reload the page, the script is injected on demand and the call retried.
async function snafEnsureContentScript(tabId) {
    try {
        return await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    } catch (e) {
        try {
            await chrome.scripting.insertCSS({ target: { tabId }, files: SNAF_CONTENT_CSS });
        } catch (cssErr) { /* already inserted, or the tab forbids it */ }
        await chrome.scripting.executeScript({ target: { tabId }, files: SNAF_CONTENT_JS });
        return await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    }
}

async function snafActiveSnTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return { tab: null, reason: 'no_tab' };
    const matches = await snafUrlMatcher();
    if (!matches(tab.url)) return { tab: null, reason: 'not_sn' };
    return { tab, reason: null };
}

// Prefers the tab the user is looking at, then any other instance tab. Used by
// the configuration page, which has no ServiceNow session of its own and so has
// to borrow a tab to run a lookup through.
async function snafAnySnTab() {
    const matches = await snafUrlMatcher();
    const active  = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active[0] && matches(active[0].url)) return active[0];
    const all = await chrome.tabs.query({});
    return all.find(t => matches(t.url)) || null;
}

async function snafSnTabs() {
    const matches = await snafUrlMatcher();
    const all     = await chrome.tabs.query({});
    return all.filter(t => matches(t.url));
}

// ── Handlers ─────────────────────────────────────────────────────────────────
async function snafOpenConfig(section) {
    const base = chrome.runtime.getURL('config.html');
    const url  = section ? base + '#' + section : base;

    const all      = await chrome.tabs.query({});
    const existing = all.find(t => t.url && t.url.split('#')[0] === base);

    if (existing) {
        await chrome.tabs.update(existing.id, { active: true, url });
        try { await chrome.windows.update(existing.windowId, { focused: true }); } catch (e) {}
        return { ok: true, reused: true };
    }
    await chrome.tabs.create({ url });
    return { ok: true, reused: false };
}

async function snafToggleWidget() {
    const { tab, reason } = await snafActiveSnTab();
    if (!tab) return { ok: false, reason };
    try {
        await snafEnsureContentScript(tab.id);
        const res = await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_WIDGET' });
        return { ok: true, visible: !!(res && res.visible) };
    } catch (e) {
        return { ok: false, reason: 'unreachable', error: String(e && e.message || e) };
    }
}

async function snafPopupState() {
    const { tab, reason } = await snafActiveSnTab();
    if (!tab) return { ok: true, isSn: false, reason };
    try {
        await snafEnsureContentScript(tab.id);
        const res = await chrome.tabs.sendMessage(tab.id, { type: 'QUERY_STATE' });
        return Object.assign({ ok: true, isSn: true }, res || {});
    } catch (e) {
        return { ok: true, isSn: true, reachable: false, error: String(e && e.message || e) };
    }
}

// Broadcast, best effort. A tab with no listener yet picks the change up when
// its content script next loads, so a failure here is not worth reporting.
async function snafBroadcastConfig() {
    const tabs = await snafSnTabs();
    await Promise.all(tabs.map(t =>
        chrome.tabs.sendMessage(t.id, { type: 'RELOAD_STATE' }).catch(() => {})
    ));
    return { ok: true, notified: tabs.length };
}

// Reads the ServiceNow user token out of the page's own JavaScript context.
// Content scripts run in an isolated world and cannot see `g_ck`, and injecting
// an inline <script> is blocked by the instance's CSP — so the read is done in
// the MAIN world through chrome.scripting, which CSP does not apply to.
async function snafReadToken(sender) {
    if (!sender || !sender.tab) return { ok: false, reason: 'no_tab' };

    const target = { tabId: sender.tab.id };
    if (typeof sender.frameId === 'number') target.frameIds = [sender.frameId];

    try {
        const results = await chrome.scripting.executeScript({
            target,
            world: 'MAIN',
            func: () => {
                try {
                    const w = window;
                    const token = w.g_ck
                        || (w.NOW && w.NOW.user && w.NOW.user.userToken)
                        || (w.g_user && w.g_user.userToken)
                        || (w.top && w.top !== w && w.top.g_ck)
                        || null;
                    // Same round trip doubles as instance detection: these
                    // globals only exist on a real ServiceNow page.
                    const isSn = !!(token || w.NOW || w.g_user || w.GlideList2 || w.g_form);
                    return { token: token, isSn: isSn };
                } catch (e) { return { token: null, isSn: false }; }
            }
        });
        const out = (results && results[0] && results[0].result) || {};
        return { ok: !!out.token, token: out.token ? String(out.token) : null, isSn: !!out.isSn };
    } catch (e) {
        return { ok: false, reason: 'inject_failed', error: String(e && e.message || e) };
    }
}

// The configuration page cannot query the Table API itself — it is an extension
// page, so it has no instance origin and no session cookie. It hands the terms
// here and they are resolved inside a real ServiceNow tab.
async function snafLookupUsers(terms) {
    const tab = await snafAnySnTab();
    if (!tab) return { ok: false, reason: 'no_sn_tab' };
    try {
        await snafEnsureContentScript(tab.id);
        const res = await chrome.tabs.sendMessage(tab.id, { type: 'RESOLVE_USERS', terms });
        let host = '';
        try { host = new URL(tab.url).hostname; } catch (e) {}
        return Object.assign({ ok: true, host }, res || {});
    } catch (e) {
        return { ok: false, reason: 'unreachable', error: String(e && e.message || e) };
    }
}

// ── Dispatch ─────────────────────────────────────────────────────────────────
async function snafHandle(msg, sender) {
    switch (msg.type) {
        case 'OPEN_CONFIG':    return snafOpenConfig(msg.section);
        case 'LAUNCH_WIDGET':  return snafToggleWidget();
        case 'POPUP_STATE':    return snafPopupState();
        case 'CONFIG_UPDATED': return snafBroadcastConfig();
        case 'READ_TOKEN':     return snafReadToken(sender);
        case 'LOOKUP_USERS':   return snafLookupUsers(msg.terms || []);
        case 'SYNC_DOMAINS':   return snafSyncDynamicScript();
        default:               return { ok: false, reason: 'unknown_type', type: msg.type };
    }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;

    // Messages bound for the content script must not be answered here, or the
    // sender receives this listener's reply instead.
    if (msg.type === 'RELOAD_STATE' || msg.type === 'TOGGLE_WIDGET' ||
        msg.type === 'QUERY_STATE'  || msg.type === 'RESOLVE_USERS' ||
        msg.type === 'PING') {
        return false;
    }

    snafHandle(msg, sender)
        .then(res => sendResponse(res))
        .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));

    return true; // response is asynchronous
});

// ── Keeping the dynamic registration in step ─────────────────────────────────
// Re-synced whenever the stored domain list changes, whenever a permission is
// granted or revoked through the browser's own UI, and once on install and
// startup so a restart doesn't lose a custom instance.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[SNAF_KEY_ALLURLS] || changes[SNAF_KEY_DOMAINS]) {
        snafSyncDynamicScript().catch(() => {});
    }
});

if (chrome.permissions && chrome.permissions.onAdded) {
    chrome.permissions.onAdded.addListener(() => { snafSyncDynamicScript().catch(() => {}); });
}
if (chrome.permissions && chrome.permissions.onRemoved) {
    chrome.permissions.onRemoved.addListener(() => { snafSyncDynamicScript().catch(() => {}); });
}

chrome.runtime.onInstalled.addListener(details => {
    snafSyncDynamicScript().catch(() => {});
    // Open the configuration page once, on a genuinely fresh install. An update
    // must not steal focus from whatever the user was doing.
    if (details.reason === 'install') {
        snafOpenConfig('groups').catch(() => {});
    }
});

chrome.runtime.onStartup.addListener(() => { snafSyncDynamicScript().catch(() => {}); });
