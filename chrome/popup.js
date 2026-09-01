'use strict';

// SN Assignflow — toolbar popup
//
// Two jobs: toggle the dispatcher widget on the active ServiceNow tab, and open
// the configuration page. The counts come straight from storage so they are
// correct even when the current tab isn't a ServiceNow one.

document.addEventListener('DOMContentLoaded', () => {
    const btnLaunch   = document.getElementById('btnLaunch');
    const launchLabel = document.getElementById('launchLabel');
    const launchIcon  = document.getElementById('launchIcon');
    const statusEl    = document.getElementById('status');
    const btnConfig   = document.getElementById('btnConfig');
    const cardVer     = document.getElementById('cardVer');
    const sumGroups   = document.getElementById('sumGroups');
    const sumAgents   = document.getElementById('sumAgents');
    const sumTotal    = document.getElementById('sumTotal');

    const ICON_PLAY = '<path d="M8 5.2v13.6L19 12z"/>';
    const ICON_STOP = '<rect x="6.5" y="6.5" width="11" height="11" rx="1.6"/>';

    let busy = false;

    try {
        const v = chrome.runtime.getManifest().version;
        if (v) cardVer.textContent = 'v' + v;
    } catch (e) { /* leave the fallback in the markup */ }

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
            setStatus('Opens the dispatcher on the active ServiceNow tab.', '');
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

    paintCounts().catch(() => {});
    paintTabState().catch(() => {});
});
