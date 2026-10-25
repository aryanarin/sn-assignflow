'use strict';

// SN Assignflow — toolbar popup
//
// Toggles the dispatcher widget on the active ServiceNow tab and opens the
// configuration page, with a bug report and the Support panel a click away. The
// counts come straight from storage so they are correct even when the current
// tab isn't a ServiceNow one.

document.addEventListener('DOMContentLoaded', () => {
    const btnLaunch   = document.getElementById('btnLaunch');
    const launchLabel = document.getElementById('launchLabel');
    const launchIcon  = document.getElementById('launchIcon');
    const statusEl    = document.getElementById('status');
    const btnConfig   = document.getElementById('btnConfig');
    const btnReportBug = document.getElementById('btnReportBug');
    const btnSupport   = document.getElementById('btnSupport');
    const btnTheme     = document.getElementById('btnTheme');
    const cardVer     = document.getElementById('cardVer');
    const sumGroups   = document.getElementById('sumGroups');
    const sumAgents   = document.getElementById('sumAgents');
    const sumTotal    = document.getElementById('sumTotal');

    const ICON_PLAY = '<path d="M8 5.2v13.6L19 12z"/>';
    const ICON_STOP = '<rect x="6.5" y="6.5" width="11" height="11" rx="1.6"/>';

    const ICON_SUN =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
        'stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/>' +
        '<path d="M12 2.6v2M12 19.4v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.6 12h2' +
        'M19.4 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg>';
    const ICON_MOON =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M20 14.5A8.2 8.2 0 0 1 9.5 4a8.4 8.4 0 1 0 10.5 10.5z"/></svg>';

    let busy = false;
    let version = '4.1.2';
    let theme = 'light';

    try {
        const v = chrome.runtime.getManifest().version;
        if (v) { version = v; cardVer.textContent = 'v' + v; }
    } catch (e) { /* leave the fallback in the markup */ }

    // popup.html carries a plain mailto that works on its own. Widening it here
    // adds the version and the browser, which is most of a useful bug report.
    btnReportBug.href = snafBugReportMailto(version, navigator.userAgent);

    // ── Theme ─────────────────────────────────────────────────────────────────
    // The same preference the widget and configuration page use, so a theme
    // picked anywhere is the theme everywhere.
    function applyTheme(next) {
        theme = snafNormaliseTheme(next);
        document.documentElement.setAttribute('data-theme', theme);

        const label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
        btnTheme.innerHTML = theme === 'dark' ? ICON_SUN : ICON_MOON;
        btnTheme.title = label;
        btnTheme.setAttribute('aria-label', label);
    }

    async function loadTheme() {
        try {
            const store = await chrome.storage.local.get(SNAF_KEY_THEME);
            applyTheme(store[SNAF_KEY_THEME]);
        } catch (e) {
            applyTheme('light');
        }
    }

    btnTheme.addEventListener('click', async () => {
        const next = theme === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        const patch = {};
        patch[SNAF_KEY_THEME] = next;
        try { await chrome.storage.local.set(patch); } catch (e) { /* repaint already happened */ }
    });

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[SNAF_KEY_THEME]) {
            applyTheme(changes[SNAF_KEY_THEME].newValue);
        }
    });

    function setStatus(text, cls) {
        statusEl.textContent = text;
        statusEl.className   = cls || '';
    }

    function setLaunchVisible(visible) {
        if (visible) {
            launchLabel.textContent = 'Hide Widget';
            launchIcon.innerHTML    = ICON_STOP;
            btnLaunch.classList.add('is-on');
        } else {
            launchLabel.textContent = 'Launch Widget';
            launchIcon.innerHTML    = ICON_PLAY;
            btnLaunch.classList.remove('is-on');
        }
    }

    // ── Counts from storage ───────────────────────────────────────────────────
    async function paintCounts() {
        const store  = await chrome.storage.local.get([SNAF_KEY_GROUPS, SNAF_KEY_STATS]);
        const groups = Array.isArray(store[SNAF_KEY_GROUPS]) ? store[SNAF_KEY_GROUPS] : [];
        const stats  = store[SNAF_KEY_STATS] || {};

        const active = groups.filter(g => g && g.active !== false);
        let agents = 0;
        active.forEach(g => { agents += snafCountActiveAgents(g); });

        sumGroups.textContent = active.length;
        sumAgents.textContent = agents;
        sumTotal.textContent  = stats.totalAssigned || 0;
    }

    // ── Tab state ─────────────────────────────────────────────────────────────
    async function paintTabState() {
        let res;
        try {
            res = await chrome.runtime.sendMessage({ type: 'POPUP_STATE' });
        } catch (e) {
            setStatus('Could not reach the extension background. Try reopening this popup.', 'err');
            return;
        }
        if (!res) { setStatus('No response from the background worker.', 'err'); return; }

        if (!res.isSn) {
            btnLaunch.disabled = true;
            setLaunchVisible(false);
            setStatus('Open a ServiceNow tab to launch the dispatcher.', '');
            return;
        }

        btnLaunch.disabled = false;

        if (res.reachable === false) {
            setLaunchVisible(false);
            setStatus('This tab has not finished loading. Try again in a moment.', 'err');
            return;
        }

        setLaunchVisible(!!res.visible);

        if (res.engine === 'running') {
            setStatus('Engine running' + (res.host ? ' on ' + res.host : '') + '.', 'ok');
        } else if (res.engine === 'paused') {
            setStatus('Engine paused. Resume it from the widget.', '');
        } else if (res.visible) {
            setStatus('Widget is open on this tab. Press Start to dispatch.', '');
        } else {
            setStatus('Opens the dispatcher on this tab only.', '');
        }
    }

    // ── Actions ───────────────────────────────────────────────────────────────
    btnLaunch.addEventListener('click', async () => {
        if (busy || btnLaunch.disabled) return;
        busy = true;
        setStatus('Working…', '');

        try {
            const res = await chrome.runtime.sendMessage({ type: 'LAUNCH_WIDGET' });

            if (res && res.ok) {
                setLaunchVisible(res.visible);
                setStatus(
                    res.visible ? 'Widget opened on this tab.' : 'Widget hidden. Your configuration is untouched.',
                    res.visible ? 'ok' : ''
                );
            } else if (res && res.reason === 'not_sn') {
                setStatus('Not a ServiceNow tab. Open your instance first.', 'err');
            } else if (res && res.reason === 'no_tab') {
                setStatus('No active tab found.', 'err');
            } else {
                setStatus('Could not reach this tab. Reload the ServiceNow page and retry.', 'err');
            }
        } catch (e) {
            setStatus('Unexpected error: ' + (e && e.message ? e.message : e), 'err');
        }
        busy = false;
    });

    btnConfig.addEventListener('click', async () => {
        try { await chrome.runtime.sendMessage({ type: 'OPEN_CONFIG', section: 'groups' }); }
        catch (e) { /* the tab still opens in the common case */ }
        window.close();
    });

    // The Support panel lives on the configuration page, so the popup asks for
    // it by name. config.js treats this hash as "open the modal", not as a
    // section to navigate to.
    btnSupport.addEventListener('click', async () => {
        try { await chrome.runtime.sendMessage({ type: 'OPEN_CONFIG', section: 'support' }); }
        catch (e) { /* the tab still opens in the common case */ }
        window.close();
    });

    // Let the mail client take over, then get out of the way.
    btnReportBug.addEventListener('click', () => setTimeout(() => window.close(), 120));

    loadTheme();
    paintCounts().catch(() => {});
    paintTabState().catch(() => {});
});
