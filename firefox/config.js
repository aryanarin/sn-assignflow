'use strict';

// SN Assignflow — configuration page
//
// Six sections behind one navigation rail. Global preferences (Rules, Settings)
// persist the moment you change them, because each control is a single complete
// decision. The group editor is different: it edits a draft and commits on Save,
// so a half-typed sys_id or filter query is never handed to a running engine.

// ── State ─────────────────────────────────────────────────────────────────────
let groups    = [];
let directory = [];
let settings  = snafDefaultSettings();
let logEntries = [];

let section  = 'groups';
let activeId = null;
let draft    = null;      // working copy of the selected group
let dirty    = false;

let dirSelection   = new Set();
let groupSelection = new Set();
let dirSaveTimer   = null;

const SECTIONS = {
    groups:   { title: 'Assignment Groups', sub: 'Define what gets assigned, and to whom' },
    rules:    { title: 'Rules',             sub: 'Safety limits and defaults for every group' },
    agents:   { title: 'Agents',            sub: 'One global list of people, reused everywhere' },
    logs:     { title: 'Logs',              sub: 'Recent engine activity across your instances' },
    settings: { title: 'Settings',          sub: 'Keep-alive, appearance and backups' },
    about:    { title: 'About',             sub: 'How SN Assignflow behaves' }
};

const $ = id => document.getElementById(id);

const elToast   = $('toast');
const elPicker  = $('filePicker');
const elTitle   = $('topbarTitle');
const elSub     = $('topbarSub');
const elGroupList   = $('groupList');
const elGroupEditor = $('groupEditor');
const elDirTable    = $('dirTable');
const elLogBody     = $('logBody');

// ── Small utilities ───────────────────────────────────────────────────────────
let toastTimer = null;
function toast(msg, kind) {
    elToast.textContent = msg;
    elToast.className   = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { elToast.className = 'toast'; }, 2600);
}

function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'application/json;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function stamp(suffix) {
    return 'sn-assignflow-' + suffix + '-' + snafDateStamp() + '.json';
}

// One hidden input, reused. The handler is replaced each time so results can be
// awaited at the call site.
function pickFile(accept) {
    return new Promise(resolve => {
        elPicker.accept = accept || '';
        elPicker.value  = '';
        elPicker.onchange = () => {
            const file = elPicker.files && elPicker.files[0];
            if (!file) { resolve(null); return; }
            const reader = new FileReader();
            reader.onload  = () => resolve({ name: file.name, text: String(reader.result) });
            reader.onerror = () => resolve(null);
            reader.readAsText(file);
        };
        elPicker.click();
    });
}

function svgIcon(paths, opts) {
    const o = opts || {};
    return '<svg viewBox="0 0 24 24" fill="' + (o.fill || 'none') + '" stroke="' + (o.stroke || 'currentColor') +
           '" stroke-width="' + (o.width || 2) + '" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>';
}

const ICON_TRASH = svgIcon('<path d="M4.5 7h15"/><path d="M9.5 7V5.4A1.4 1.4 0 0 1 10.9 4h2.2a1.4 1.4 0 0 1 1.4 1.4V7"/>' +
                           '<path d="M6.5 7l.8 11.4A1.6 1.6 0 0 0 8.9 20h6.2a1.6 1.6 0 0 0 1.6-1.6L17.5 7"/>' +
                           '<path d="M10.5 11v5"/><path d="M13.5 11v5"/>', { width: 1.8 });

function avatarEl(seed, label, large) {
    const el = document.createElement('span');
    el.className = 'avatar' + (large ? ' lg' : '');
    el.style.background = 'hsl(' + snafAvatarHue(seed || label) + ' 58% 48%)';
    el.textContent = snafInitials(label || seed);
    el.title = label || seed || '';
    return el;
}

// Toggles are buttons rather than checkboxes so they can carry the sliding knob
// without a wrapper label. This keeps them behaving like switches regardless.
function wireToggle(el, read, write) {
    function paint() {
        const on = !!read();
        el.classList.toggle('on', on);
        el.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    el.addEventListener('click', () => { write(!read()); paint(); });
    paint();
    return paint;
}

function makeToggle(on, onChange, small) {
    const el = document.createElement('button');
    el.type      = 'button';
    el.className = 'toggle' + (small ? ' sm' : '') + (on ? ' on' : '');
    el.setAttribute('role', 'switch');
    el.setAttribute('aria-checked', on ? 'true' : 'false');
    const knob = document.createElement('span');
    knob.className = 'toggle-knob';
    el.appendChild(knob);
    el.addEventListener('click', e => {
        e.stopPropagation();
        const next = !el.classList.contains('on');
        el.classList.toggle('on', next);
        el.setAttribute('aria-checked', next ? 'true' : 'false');
        onChange(next);
    });
    return el;
}

// ── Storage ───────────────────────────────────────────────────────────────────
async function loadAll() {
    const store = await chrome.storage.local.get([
        SNAF_KEY_GROUPS, SNAF_KEY_USERS, SNAF_KEY_SETTINGS, SNAF_KEY_LOGS, SNAF_KEY_THEME
    ]);
    groups     = Array.isArray(store[SNAF_KEY_GROUPS]) ? store[SNAF_KEY_GROUPS] : [];
    directory  = snafNormaliseUsers(store[SNAF_KEY_USERS]);
    settings   = snafNormaliseSettings(store[SNAF_KEY_SETTINGS]);
    logEntries = Array.isArray(store[SNAF_KEY_LOGS]) ? store[SNAF_KEY_LOGS] : [];
    applyTheme(store[SNAF_KEY_THEME] === 'dark' ? 'dark' : 'light');
}

function notifyTabs() {
    chrome.runtime.sendMessage({ type: 'CONFIG_UPDATED' }).catch(() => {});
}

async function saveGroups(notify) {
    const patch = {};
    patch[SNAF_KEY_GROUPS] = groups;
    await chrome.storage.local.set(patch);
    if (notify !== false) notifyTabs();
    paintCounts();
}

async function saveDirectory() {
    const patch = {};
    patch[SNAF_KEY_USERS] = directory;
    await chrome.storage.local.set(patch);
    paintCounts();
}

async function saveSettings() {
    const patch = {};
    patch[SNAF_KEY_SETTINGS] = settings;
    await chrome.storage.local.set(patch);
    // The widget watches storage directly for settings, so no broadcast needed.
}

function paintCounts() {
    $('countGroups').textContent = groups.filter(g => g && g.active !== false).length;
    $('countUsers').textContent  = directory.length;
}

// ── Theme ─────────────────────────────────────────────────────────────────────
const ICON_SUN  = svgIcon('<circle cx="12" cy="12" r="4"/><path d="M12 2.6v2M12 19.4v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.6 12h2M19.4 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>', { width: 1.9 });
const ICON_MOON = svgIcon('<path d="M20 14.5A8.2 8.2 0 0 1 9.5 4a8.4 8.4 0 1 0 10.5 10.5z"/>', { width: 1.9 });

function applyTheme(next) {
    document.documentElement.setAttribute('data-theme', next);
    // The button offers the theme you would switch to, not the one you're in.
    $('themeIcon').innerHTML  = next === 'dark' ? ICON_SUN : ICON_MOON;
    $('themeLabel').textContent = next === 'dark' ? 'Light' : 'Dark';
    const sel = $('themeSelect');
    if (sel) sel.value = next;
}

async function setTheme(next) {
    applyTheme(next);
    const patch = {};
    patch[SNAF_KEY_THEME] = next;
    await chrome.storage.local.set(patch);
}

// ── Navigation ────────────────────────────────────────────────────────────────
function go(next, fromHash) {
    if (!SECTIONS[next]) next = 'groups';
    if (next === section && fromHash) return;

    if (section === 'groups' && next !== 'groups' && !confirmDiscard()) {
        // Put the hash back so it matches what is actually shown.
        if (location.hash.slice(1) !== 'groups') location.hash = 'groups';
        return;
    }

    section = next;

    document.querySelectorAll('.rail-item').forEach(b =>
        b.classList.toggle('is-active', b.dataset.section === section));
    document.querySelectorAll('.panel').forEach(p =>
        p.classList.toggle('is-active', p.dataset.panel === section));

    elTitle.textContent = SECTIONS[section].title;
    elSub.textContent   = SECTIONS[section].sub;

    ['tbGroups', 'tbAgents', 'tbLogs'].forEach(id => { $(id).style.display = 'none'; });
    if (section === 'groups') $('tbGroups').style.display = 'flex';
    if (section === 'agents') $('tbAgents').style.display = 'flex';
    if (section === 'logs')   $('tbLogs').style.display   = 'flex';

    if (location.hash.slice(1) !== section) location.hash = section;

    if (section === 'agents')   renderDirectory();
    if (section === 'logs')     renderLogs();
    if (section === 'about')    renderAbout();
    if (section === 'settings') renderDomains().catch(() => {});
}

document.querySelectorAll('.rail-item').forEach(btn => {
    btn.addEventListener('click', () => go(btn.dataset.section));
});
window.addEventListener('hashchange', () => go(location.hash.slice(1), true));

// ── Dirty tracking ────────────────────────────────────────────────────────────
function setDirty(on) {
    dirty = !!on;
    $('tbGroups').classList.toggle('is-dirty', dirty);
    $('btnSaveGroup').disabled = !dirty || !draft;
}

function confirmDiscard() {
    if (!dirty) return true;
    return confirm('This group has unsaved changes. Discard them?');
}

window.addEventListener('beforeunload', e => {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = '';
});

// ── Group list ────────────────────────────────────────────────────────────────
// Which groups pass the current filter. Select-all and the bulk actions operate
// on this, not on the whole list, so a filtered "select all" means what it says.
function shownGroups() {
    const term = ($('groupSearch').value || '').trim().toLowerCase();
    if (!term) return groups.slice();
    return groups.filter(g =>
        (g.name || '').toLowerCase().includes(term) ||
        (g.table || '').toLowerCase().includes(term));
}

function paintGroupBulk() {
    const shown    = shownGroups();
    const picked   = shown.filter(g => groupSelection.has(g.id));
    const bulk     = $('groupBulk');
    const selectAll = $('groupSelectAll');

    bulk.style.display = groupSelection.size ? 'flex' : 'none';
    $('groupBulkCount').textContent = snafPlural(groupSelection.size, 'group') + ' selected';

    // Indeterminate when only some of the visible groups are picked, which is
    // the honest state and stops the header checkbox lying about the selection.
    selectAll.checked       = shown.length > 0 && picked.length === shown.length;
    selectAll.indeterminate = picked.length > 0 && picked.length < shown.length;
    selectAll.disabled      = shown.length === 0;
}

function renderGroupList() {
    // Prune selections for groups that no longer exist. Doing it here covers
    // deletion, import, backup restore and reset in one place, instead of a
    // clear() call at each of those sites that someone will forget to add.
    if (groupSelection.size) {
        const live = new Set(groups.map(g => g.id));
        Array.from(groupSelection).forEach(id => { if (!live.has(id)) groupSelection.delete(id); });
    }

    elGroupList.innerHTML = '';
    const shown = shownGroups();

    if (!groups.length) {
        const e = document.createElement('div');
        e.className = 'list-empty';
        e.textContent = 'No groups yet. Use + Add to create your first one.';
        elGroupList.appendChild(e);
        paintGroupBulk();
        return;
    }
    if (!shown.length) {
        const e = document.createElement('div');
        e.className = 'list-empty';
        e.textContent = 'No group matches that filter.';
        elGroupList.appendChild(e);
        paintGroupBulk();
        return;
    }

    shown.forEach(g => {
        const item = document.createElement('div');
        item.className = 'list-item' +
            (g.id === activeId ? ' is-active' : '') +
            (groupSelection.has(g.id) ? ' is-picked' : '');

        const cb = document.createElement('input');
        cb.type      = 'checkbox';
        cb.className = 'list-item-check';
        cb.checked   = groupSelection.has(g.id);
        cb.setAttribute('aria-label', 'Select ' + (g.name || 'Unnamed group'));
        // The row opens the group for editing, so the checkbox must not bubble.
        cb.addEventListener('click', e => e.stopPropagation());
        cb.addEventListener('change', () => {
            if (cb.checked) groupSelection.add(g.id); else groupSelection.delete(g.id);
            item.classList.toggle('is-picked', cb.checked);
            paintGroupBulk();
        });
        item.appendChild(cb);

        const main = document.createElement('div');
        main.className = 'list-item-main';

        const name = document.createElement('div');
        name.className   = 'list-item-name';
        name.textContent = g.name || 'Unnamed group';

        const meta = document.createElement('div');
        meta.className   = 'list-item-meta';
        const n = snafCountActiveAgents(g);
        meta.textContent = snafPlural(n, 'agent') + ' · ' + (g.table || settings.rules.defaultTable);

        main.appendChild(name);
        main.appendChild(meta);

        const badge = document.createElement('span');
        badge.className   = 'badge ' + (g.active !== false ? 'on' : 'off');
        badge.textContent = g.active !== false ? 'On' : 'Off';

        item.appendChild(main);
        item.appendChild(badge);
        item.addEventListener('click', () => selectGroup(g.id));
        elGroupList.appendChild(item);
    });

    paintGroupBulk();
}

$('groupSelectAll').addEventListener('change', () => {
    const shown = shownGroups();
    if ($('groupSelectAll').checked) shown.forEach(g => groupSelection.add(g.id));
    else                             shown.forEach(g => groupSelection.delete(g.id));
    renderGroupList();
});

$('btnGroupExportSel').addEventListener('click', async () => {
    const picked = groups.filter(g => groupSelection.has(g.id));
    if (!picked.length) return;
    const store = await chrome.storage.local.get(SNAF_KEY_RR);
    exportGroupFile(picked, store[SNAF_KEY_RR] || {}, picked.length === groups.length);
});

$('btnGroupDeleteSel').addEventListener('click', async () => {
    const picked = groups.filter(g => groupSelection.has(g.id));
    if (!picked.length) return;

    const names = picked.map(g => g.name || 'Unnamed group').join(', ');
    if (!confirm('Delete ' + snafPlural(picked.length, 'group') + '?\n\n' + names +
                 '\n\nThis cannot be undone. Your global user list is untouched.')) return;

    const ids = new Set(picked.map(g => g.id));
    groups = groups.filter(g => !ids.has(g.id));

    // Drop the orphaned round-robin cursors along with the groups.
    const store = await chrome.storage.local.get(SNAF_KEY_RR);
    const rr    = store[SNAF_KEY_RR] || {};
    let touched = false;
    ids.forEach(id => { if (rr[id] !== undefined) { delete rr[id]; touched = true; } });
    if (touched) {
        const patch = {};
        patch[SNAF_KEY_RR] = rr;
        await chrome.storage.local.set(patch);
    }

    if (ids.has(activeId)) { activeId = null; draft = null; setDirty(false); }
    groupSelection.clear();

    await saveGroups();
    renderGroupList();
    renderEditor();
    toast('Deleted ' + snafPlural(picked.length, 'group'));
});

function selectGroup(id) {
    if (id === activeId) return;
    if (!confirmDiscard()) return;
    activeId = id;
    const g  = groups.find(x => x.id === id);
    draft    = g ? JSON.parse(JSON.stringify(g)) : null;
    setDirty(false);
    renderGroupList();
    renderEditor();
}

$('groupSearch').addEventListener('input', renderGroupList);

$('btnAddGroup').addEventListener('click', async () => {
    if (!confirmDiscard()) return;
    const g = {
        id: snafUid(),
        name: 'New group',
        table: settings.rules.defaultTable,
        query: '',
        agents: [],
        active: true
    };
    groups.push(g);
    await saveGroups();
    activeId = g.id;
    draft    = JSON.parse(JSON.stringify(g));
    setDirty(false);
    renderGroupList();
    renderEditor();
    toast('Group created', 'ok');
});

// ── Group editor ──────────────────────────────────────────────────────────────
function renderEditor() {
    elGroupEditor.innerHTML = '';

    const activeWrap = $('groupActiveWrap');

    if (!draft) {
        activeWrap.style.display = 'none';
        $('btnSaveGroup').disabled = true;

        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.innerHTML =
            '<div class="empty-icon">' + svgIcon(
                '<path d="M15.5 19.5V18a3.5 3.5 0 0 0-3.5-3.5H7A3.5 3.5 0 0 0 3.5 18v1.5"/>' +
                '<circle cx="9.5" cy="8" r="3.3"/>' +
                '<path d="M20.5 19.5V18a3.5 3.5 0 0 0-2.6-3.38"/>' +
                '<path d="M15.2 5.1a3.3 3.3 0 0 1 0 5.8"/>', { width: 1.5 }) + '</div>' +
            '<div class="empty-title">No group selected</div>' +
            '<div class="empty-text">Pick a group on the left, or create one with + Add.</div>';
        elGroupEditor.appendChild(empty);
        return;
    }

    activeWrap.style.display = 'flex';
    const activeBtn = $('groupActive');
    activeBtn.classList.toggle('on', draft.active !== false);
    activeBtn.setAttribute('aria-checked', draft.active !== false ? 'true' : 'false');

    const scroll = document.createElement('div');
    scroll.className = 'editor-scroll';

    const inner = document.createElement('div');
    inner.className = 'panel-inner';
    scroll.appendChild(inner);

    // ── Identity ──
    const idSec = document.createElement('div');
    idSec.className = 'section';
    idSec.innerHTML = '<div class="section-head"><div class="section-title">Assignment Group Configuration</div></div>';

    const box1 = document.createElement('div');
    box1.className = 'card-box';

    const grid = document.createElement('div');
    grid.className = 'grid-2';

    const nameField = document.createElement('div');
    nameField.className = 'field';
    nameField.innerHTML = '<label class="field-label" for="fGroupName">Group Name</label>';
    const nameInput = document.createElement('input');
    nameInput.className = 'input';
    nameInput.id        = 'fGroupName';
    nameInput.value     = draft.name || '';
    nameInput.placeholder = 'e.g. Network dispatch';
    nameInput.addEventListener('input', () => { draft.name = nameInput.value; setDirty(true); });
    nameField.appendChild(nameInput);

    const tableField = document.createElement('div');
    tableField.className = 'field';
    tableField.innerHTML = '<label class="field-label" for="fGroupTable">Table</label>';
    const tableInput = document.createElement('input');
    tableInput.className   = 'input mono';
    tableInput.id          = 'fGroupTable';
    tableInput.value       = draft.table || settings.rules.defaultTable;
    tableInput.placeholder = 'incident';
    tableInput.addEventListener('input', () => { draft.table = tableInput.value.trim(); setDirty(true); });
    tableField.appendChild(tableInput);

    grid.appendChild(nameField);
    grid.appendChild(tableField);
    box1.appendChild(grid);

    // ── URL converter ──
    const conv = document.createElement('div');
    conv.className = 'field';
    conv.style.marginTop = '14px';
    conv.innerHTML = '<label class="field-label" for="fConv">Build the query from a ServiceNow list URL</label>';

    const convRow = document.createElement('div');
    convRow.className = 'url-tool';
    const convInput = document.createElement('input');
    convInput.className   = 'input';
    convInput.id          = 'fConv';
    convInput.placeholder = 'Paste a filtered list URL…';
    const convBtn = document.createElement('button');
    convBtn.className   = 'btn btn-secondary';
    convBtn.textContent = 'Apply';
    convRow.appendChild(convInput);
    convRow.appendChild(convBtn);
    conv.appendChild(convRow);

    const convHint = document.createElement('div');
    convHint.className = 'hint';
    convHint.style.marginTop = '5px';
    convHint.textContent = 'Reads sysparm_query and the table name, including from multiply-encoded navigation URLs.';
    conv.appendChild(convHint);
    box1.appendChild(conv);

    // ── Query ──
    const qField = document.createElement('div');
    qField.className = 'field';
    qField.style.marginTop = '14px';
    qField.innerHTML = '<label class="field-label" for="fQuery">Filter Query (sysparm_query)</label>';
    const qInput = document.createElement('textarea');
    qInput.className   = 'textarea mono';
    qInput.id          = 'fQuery';
    qInput.value       = draft.query || '';
    qInput.placeholder = 'assignment_group=<sys_id>^assigned_toISEMPTY';
    qInput.rows        = 3;
    qInput.addEventListener('input', () => { draft.query = qInput.value.trim(); setDirty(true); });
    qField.appendChild(qInput);

    const qHint = document.createElement('div');
    qHint.className = 'hint';
    qHint.style.marginTop = '5px';
    qHint.textContent = settings.rules.requireUnassigned
        ? 'The unassigned-only rule is on, so ^assigned_toISEMPTY is added automatically when missing.'
        : 'The unassigned-only rule is off — this query decides on its own what gets reassigned.';
    qField.appendChild(qHint);
    box1.appendChild(qField);

    convBtn.addEventListener('click', () => {
        const raw = convInput.value.trim();
        if (!raw) { toast('Paste a ServiceNow list URL first', 'warn'); return; }
        const q = snafExtractQuery(raw);
        const t = snafExtractTable(raw);
        if (!q) { toast('No sysparm_query in that URL — filter the list first', 'err'); return; }
        draft.query   = q;
        qInput.value  = q;
        if (t) { draft.table = t; tableInput.value = t; }
        convInput.value = '';
        setDirty(true);
        toast(t ? 'Query and table applied' : 'Query applied', 'ok');
    });
    convInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); convBtn.click(); } });

    idSec.appendChild(box1);
    inner.appendChild(idSec);

    // ── Agents ──
    const agSec = document.createElement('div');
    agSec.className = 'section';
    agSec.innerHTML =
        '<div class="section-head"><div class="section-title">Agents (Round Robin)</div>' +
        '<div class="section-desc">Assigned in this order, cycling on each ticket. ' +
        'Enter a ServiceNow user ID or a sys_id — suggestions come from your global list.</div></div>';

    const agBody = document.createElement('div');
    agSec.appendChild(agBody);
    inner.appendChild(agSec);
    renderAgentRows(agBody);

    // ── Delete ──
    const dz = document.createElement('div');
    dz.className = 'section';
    const dzBox = document.createElement('div');
    dzBox.className = 'card-box';
    dzBox.style.display = 'flex';
    dzBox.style.alignItems = 'center';
    dzBox.style.gap = '14px';
    const dzText = document.createElement('div');
    dzText.style.flex = '1';
    dzText.innerHTML = '<div class="setting-name">Delete this group</div>' +
                       '<div class="setting-desc">Removes the group and its round-robin position. Your global user list is untouched.</div>';
    const dzBtn = document.createElement('button');
    dzBtn.className   = 'btn btn-danger';
    dzBtn.textContent = 'Delete group';
    dzBtn.addEventListener('click', () => deleteGroup(draft.id, draft.name));
    dzBox.appendChild(dzText);
    dzBox.appendChild(dzBtn);
    dz.appendChild(dzBox);
    inner.appendChild(dz);

    elGroupEditor.appendChild(scroll);
    setDirty(dirty);
}

function renderAgentRows(container) {
    container.innerHTML = '';
    if (!Array.isArray(draft.agents)) draft.agents = [];

    const list = document.createElement('div');
    list.className = 'agent-list';

    if (!draft.agents.length) {
        const none = document.createElement('div');
        none.className = 'hint';
        none.style.padding = '4px 0 8px';
        none.textContent = 'No agents yet. Add at least one for this group to run.';
        list.appendChild(none);
    }

    draft.agents.forEach((agent, idx) => {
        const hint = snafResolveHint(agent);

        const row = document.createElement('div');
        row.className = 'agent-row' +
            (agent.active === false ? ' is-off' : '') +
            (hint.mode === 'invalid' ? ' has-error' : '');

        row.appendChild(makeToggle(agent.active !== false, on => {
            agent.active = on;
            row.classList.toggle('is-off', !on);
            setDirty(true);
        }, true));

        row.appendChild(avatarEl(agent.user_name || agent.sys_id, agent.name || agent.user_name || '?'));

        // Name, with directory suggestions.
        const ac = buildSuggestField({
            className:   'agent-name',
            placeholder: 'Agent name',
            value:       agent.name || '',
            onInput: v => { agent.name = v; setDirty(true); },
            onPick: u => {
                agent.name      = u.name || u.user_name || '';
                agent.user_name = u.user_name || '';
                agent.sys_id    = u.sys_id || '';
                setDirty(true);
                renderAgentRows(container);
            }
        });
        row.appendChild(ac.wrap);

        // Identity: a user ID or a sys_id, whichever you have.
        const ident = document.createElement('input');
        ident.className   = 'agent-id';
        ident.placeholder = 'user ID or sys_id';
        ident.value       = agent.sys_id || agent.user_name || '';
        ident.title       = 'ServiceNow user ID, or a 32-character sys_id';
        ident.addEventListener('input', () => {
            const v = ident.value.trim();
            if (snafIsSysId(v)) { agent.sys_id = v.toLowerCase(); }
            else { agent.user_name = v; agent.sys_id = ''; }
            setDirty(true);
            paintAgentState(state, agent);
        });
        row.appendChild(ident);

        const state = document.createElement('span');
        state.className = 'agent-state';
        paintAgentState(state, agent);
        row.appendChild(state);

        const order = document.createElement('span');
        order.className   = 'agent-order';
        order.textContent = String(idx + 1);
        order.title       = 'Position in the rotation';
        row.appendChild(order);

        const del = document.createElement('button');
        del.className = 'icon-btn danger';
        del.title     = 'Remove from this group';
        del.setAttribute('aria-label', 'Remove agent');
        del.innerHTML = ICON_TRASH;
        del.addEventListener('click', () => {
            draft.agents.splice(idx, 1);
            setDirty(true);
            renderAgentRows(container);
        });
        row.appendChild(del);

        list.appendChild(row);
    });

    container.appendChild(list);

    // ── Add row ──
    const add = document.createElement('div');
    add.className = 'agent-add';

    const addAc = buildSuggestField({
        className:   'input',
        placeholder: 'Name or user ID — start typing for suggestions',
        value:       '',
        onPick: u => {
            addName.value  = u.name || u.user_name || '';
            addIdent.value = u.sys_id || u.user_name || '';
            addIdent.focus();
        }
    });
    const addName = addAc.input;

    const addIdent = document.createElement('input');
    addIdent.className   = 'input mono';
    addIdent.placeholder = 'user ID or sys_id';
    addIdent.style.cssText = 'width:190px;flex:0 0 auto;';

    const addBtn = document.createElement('button');
    addBtn.className   = 'btn btn-primary';
    addBtn.textContent = '+ Add Agent';

    function commitAdd() {
        const name  = addName.value.trim();
        const ident = addIdent.value.trim();
        if (!name && !ident) { toast('Enter a name or a user ID', 'warn'); return; }

        const agent = { name: name, user_name: '', sys_id: '', active: true };
        if (snafIsSysId(ident)) agent.sys_id = ident.toLowerCase();
        else if (ident)         agent.user_name = ident;

        // No identity typed: fall back to the directory, then to the name itself.
        if (!agent.sys_id && !agent.user_name) {
            const hit = snafFindUser(directory, name);
            if (hit) {
                agent.user_name = hit.user_name || '';
                agent.sys_id    = hit.sys_id || '';
            }
        }
        if (snafResolveHint(agent).mode === 'invalid') {
            toast('That entry has nothing the engine can resolve', 'err');
            return;
        }

        draft.agents.push(agent);
        addName.value  = '';
        addIdent.value = '';
        setDirty(true);
        renderAgentRows(container);
        addName.focus();
    }

    addBtn.addEventListener('click', commitAdd);
    addIdent.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commitAdd(); } });

    add.appendChild(addAc.wrap);
    add.appendChild(addIdent);
    add.appendChild(addBtn);
    container.appendChild(add);
}

function paintAgentState(el, agent) {
    const hint = snafResolveHint(agent);
    if (hint.mode === 'ready') {
        el.className   = 'agent-state resolved';
        el.textContent = 'sys_id set';
        el.title       = hint.sys_id;
    } else if (hint.mode === 'lookup') {
        const known = snafFindUser(directory, hint.term);
        if (known && known.sys_id) {
            el.className   = 'agent-state resolved';
            el.textContent = 'in directory';
            el.title       = known.sys_id;
        } else {
            el.className   = 'agent-state pending';
            el.textContent = 'resolve on run';
            el.title       = 'Looked up from "' + hint.term + '" the first time this group runs';
        }
    } else {
        el.className   = 'agent-state error';
        el.textContent = 'incomplete';
        el.title       = hint.reason || '';
    }
}

// ── Suggestion field ──────────────────────────────────────────────────────────
// Free text with a ranked dropdown from the global directory. Picking is
// optional by design: a one-off agent that isn't in the list must still work.
function buildSuggestField(opts) {
    const wrap = document.createElement('div');
    wrap.className = 'ac-wrap';

    const input = document.createElement('input');
    input.className   = opts.className || 'input';
    input.placeholder = opts.placeholder || '';
    input.value       = opts.value || '';
    input.autocomplete = 'off';

    const menu = document.createElement('div');
    menu.className = 'ac-menu';

    wrap.appendChild(input);
    wrap.appendChild(menu);

    let items  = [];
    let cursor = -1;

    function close() { menu.classList.remove('is-open'); cursor = -1; }

    function paintCursor() {
        Array.prototype.forEach.call(menu.querySelectorAll('.ac-item'), (el, i) =>
            el.classList.toggle('is-cursor', i === cursor));
    }

    function open() {
        menu.innerHTML = '';
        items  = snafMatchUsers(directory, input.value, 8);
        cursor = -1;

        if (!directory.length) {
            const n = document.createElement('div');
            n.className   = 'ac-empty';
            n.textContent = 'Your global user list is empty. Add people under Agents to get suggestions here.';
            menu.appendChild(n);
        } else if (!items.length) {
            const n = document.createElement('div');
            n.className   = 'ac-empty';
            n.textContent = 'No match in the global list — what you typed will be used as-is.';
            menu.appendChild(n);
        } else {
            items.forEach((u, i) => {
                const it = document.createElement('div');
                it.className = 'ac-item';

                it.appendChild(avatarEl(u.user_name || u.sys_id, u.name || u.user_name));

                const main = document.createElement('div');
                main.className = 'ac-item-main';
                const nm = document.createElement('div');
                nm.className   = 'ac-item-name';
                nm.textContent = u.name || u.user_name || '(unnamed)';
                const mt = document.createElement('div');
                mt.className   = 'ac-item-meta';
                mt.textContent = [u.user_name, u.sys_id ? u.sys_id.slice(0, 8) + '…' : 'no sys_id']
                                    .filter(Boolean).join('  ·  ');
                main.appendChild(nm);
                main.appendChild(mt);
                it.appendChild(main);

                // mousedown, not click: blur would close the menu first.
                it.addEventListener('mousedown', e => {
                    e.preventDefault();
                    close();
                    if (opts.onPick) opts.onPick(u);
                });
                it.addEventListener('mouseenter', () => { cursor = i; paintCursor(); });

                menu.appendChild(it);
            });

            const note = document.createElement('div');
            note.className   = 'ac-note';
            note.textContent = 'Arrow keys to choose, Enter to accept, Esc to keep what you typed.';
            menu.appendChild(note);
        }

        menu.classList.add('is-open');
    }

    input.addEventListener('focus', open);
    input.addEventListener('input', () => {
        if (opts.onInput) opts.onInput(input.value);
        open();
    });
    input.addEventListener('blur', () => setTimeout(close, 120));
    input.addEventListener('keydown', e => {
        if (e.key === 'Escape') { close(); return; }
        if (!items.length) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            cursor = (cursor + 1) % items.length;
            paintCursor();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            cursor = cursor <= 0 ? items.length - 1 : cursor - 1;
            paintCursor();
        } else if (e.key === 'Enter' && cursor >= 0) {
            e.preventDefault();
            const u = items[cursor];
            close();
            if (opts.onPick) opts.onPick(u);
        }
    });

    return { wrap: wrap, input: input, close: close };
}

// ── Group save / delete ───────────────────────────────────────────────────────
$('groupActive').addEventListener('click', () => {
    if (!draft) return;
    const el   = $('groupActive');
    const next = !el.classList.contains('on');
    el.classList.toggle('on', next);
    el.setAttribute('aria-checked', next ? 'true' : 'false');
    draft.active = next;
    setDirty(true);
});

$('btnSaveGroup').addEventListener('click', async () => {
    if (!draft) return;

    if (!String(draft.query || '').trim()) {
        toast('Add a filter query before saving — the group cannot run without one', 'warn');
    }

    const idx = groups.findIndex(g => g.id === draft.id);
    const copy = JSON.parse(JSON.stringify(draft));
    if (idx === -1) groups.push(copy); else groups[idx] = copy;

    await saveGroups();
    setDirty(false);
    renderGroupList();
    toast('Changes saved', 'ok');
});

document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        if (section === 'groups' && dirty) { e.preventDefault(); $('btnSaveGroup').click(); }
    }
});

async function deleteGroup(id, name) {
    if (!confirm('Delete the group "' + (name || 'Unnamed group') + '"? This cannot be undone.')) return;

    groups = groups.filter(g => g.id !== id);

    // Drop the orphaned round-robin cursor rather than leaving it behind.
    const store = await chrome.storage.local.get(SNAF_KEY_RR);
    const rr    = store[SNAF_KEY_RR] || {};
    if (rr[id] !== undefined) {
        delete rr[id];
        const patch = {};
        patch[SNAF_KEY_RR] = rr;
        await chrome.storage.local.set(patch);
    }

    activeId = null;
    draft    = null;
    setDirty(false);
    await saveGroups();
    renderGroupList();
    renderEditor();
    toast('Group deleted');
}

// ── Selection modal ───────────────────────────────────────────────────────────
// Shared by both selective exports. Everything starts selected, because
// "export all but one" is the common case.
function openPickModal(opts) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'modal';

    const head = document.createElement('div');
    head.className = 'modal-header';
    const title = document.createElement('div');
    title.className   = 'modal-title';
    title.textContent = opts.title;
    const xBtn = document.createElement('button');
    xBtn.className = 'icon-btn';
    xBtn.setAttribute('aria-label', 'Close');
    xBtn.innerHTML = svgIcon('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>');
    head.appendChild(title);
    head.appendChild(xBtn);

    const bar = document.createElement('div');
    bar.className = 'modal-toolbar';
    const count = document.createElement('span');
    count.className = 'hint';
    count.style.flex = '1';
    const selAll = document.createElement('button');
    selAll.className   = 'btn btn-ghost btn-sm';
    selAll.textContent = 'Select all';
    const selNone = document.createElement('button');
    selNone.className   = 'btn btn-ghost btn-sm';
    selNone.textContent = 'Select none';
    bar.appendChild(count);
    bar.appendChild(selAll);
    bar.appendChild(selNone);

    const body = document.createElement('div');
    body.className = 'modal-body';

    const boxes = [];
    opts.items.forEach(item => {
        const row = document.createElement('label');
        row.className = 'pick sel';

        const cb = document.createElement('input');
        cb.type    = 'checkbox';
        cb.checked = true;

        const main = document.createElement('div');
        main.className = 'pick-main';
        const nm = document.createElement('div');
        nm.className   = 'pick-name';
        nm.textContent = opts.labelOf(item);
        const mt = document.createElement('div');
        mt.className   = 'pick-meta';
        mt.textContent = opts.metaOf ? opts.metaOf(item) : '';
        main.appendChild(nm);
        main.appendChild(mt);

        row.appendChild(cb);
        row.appendChild(main);

        function sync() {
            row.classList.toggle('sel', cb.checked);
            update();
        }
        cb.addEventListener('change', sync);

        boxes.push({ cb: cb, item: item, sync: sync });
        body.appendChild(row);
    });

    const foot = document.createElement('div');
    foot.className = 'modal-footer';

    let formatSel = null;
    if (opts.withFormat) {
        formatSel = document.createElement('select');
        formatSel.className = 'select';
        formatSel.style.width = 'auto';
        formatSel.style.marginRight = 'auto';
        formatSel.innerHTML = '<option value="json">JSON</option><option value="csv">CSV</option>';
        formatSel.setAttribute('aria-label', 'Export format');
        foot.appendChild(formatSel);
    }

    const allBtn = document.createElement('button');
    allBtn.className   = 'btn btn-secondary';
    allBtn.textContent = 'Export all (' + opts.items.length + ')';

    const selBtn = document.createElement('button');
    selBtn.className   = 'btn btn-primary';
    selBtn.textContent = 'Export selected';

    foot.appendChild(allBtn);
    foot.appendChild(selBtn);

    modal.appendChild(head);
    modal.appendChild(bar);
    modal.appendChild(body);
    modal.appendChild(foot);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    function update() {
        const n = boxes.filter(b => b.cb.checked).length;
        count.textContent  = n + ' of ' + opts.items.length + ' selected';
        selBtn.disabled    = n === 0;
    }
    update();

    function close() { backdrop.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }

    document.addEventListener('keydown', onKey);
    xBtn.addEventListener('click', close);
    backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

    selAll.addEventListener('click', () => boxes.forEach(b => { b.cb.checked = true;  b.sync(); }));
    selNone.addEventListener('click', () => boxes.forEach(b => { b.cb.checked = false; b.sync(); }));

    const fmt = () => (formatSel ? formatSel.value : 'json');
    allBtn.addEventListener('click', () => { opts.onExport(opts.items.slice(), fmt(), true); close(); });
    selBtn.addEventListener('click', () => {
        opts.onExport(boxes.filter(b => b.cb.checked).map(b => b.item), fmt(), false);
        close();
    });
}

// ── Group import / export ─────────────────────────────────────────────────────
// Shared by the export modal and the bulk-select bar.
function exportGroupFile(sel, rr, isAll) {
    const selRr = {};
    sel.forEach(g => { if (rr[g.id] !== undefined) selRr[g.id] = rr[g.id]; });

    // Agents referenced by the exported groups travel with them, so the file
    // lands somewhere else complete rather than half-resolved.
    const terms = new Set();
    sel.forEach(g => (g.agents || []).forEach(a => {
        if (a && a.sys_id)    terms.add(a.sys_id.toLowerCase());
        if (a && a.user_name) terms.add(a.user_name.toLowerCase());
        if (a && a.name)      terms.add(a.name.toLowerCase());
    }));
    const users = directory.filter(u =>
        (u.sys_id    && terms.has(u.sys_id.toLowerCase())) ||
        (u.user_name && terms.has(u.user_name.toLowerCase())) ||
        (u.name      && terms.has(u.name.toLowerCase())));

    download(
        stamp(isAll ? 'groups-all' : 'groups-' + sel.length),
        JSON.stringify({
            version:    SNAF_EXPORT_VERSION,
            kind:       'groups',
            exportedAt: new Date().toISOString(),
            groups:     sel,
            users:      users,
            rr:         selRr
        }, null, 2)
    );
    toast('Exported ' + snafPlural(sel.length, 'group'), 'ok');
}

$('btnGroupExport').addEventListener('click', async () => {
    if (!groups.length) { toast('There are no groups to export', 'warn'); return; }

    const store = await chrome.storage.local.get([SNAF_KEY_RR, SNAF_KEY_STATS]);
    const rr    = store[SNAF_KEY_RR] || {};

    openPickModal({
        title:   'Export assignment groups',
        items:   groups,
        labelOf: g => g.name || 'Unnamed group',
        metaOf:  g => snafPlural(snafCountActiveAgents(g), 'agent') + ' · ' +
                      (g.table || settings.rules.defaultTable) +
                      (g.active === false ? ' · off' : ''),
        onExport: (sel, format, isAll) => exportGroupFile(sel, rr, isAll)
    });
});

$('btnGroupImport').addEventListener('click', async () => {
    if (!confirmDiscard()) return;

    const file = await pickFile('.json,application/json');
    if (!file) return;

    let data;
    try { data = JSON.parse(file.text); }
    catch (e) { toast('That file is not valid JSON', 'err'); return; }

    const incoming = Array.isArray(data) ? data : (Array.isArray(data.groups) ? data.groups : null);
    if (!incoming) { toast('No "groups" array found in that file', 'err'); return; }

    const merge = confirm(
        'Import ' + snafPlural(incoming.length, 'group') + '.\n\n' +
        'OK — add them to your existing groups.\n' +
        'Cancel — replace everything you have now.'
    );

    // Fresh ids on merge so an import can't collide with a group you already
    // have, or share its round-robin cursor.
    const cleaned = incoming.map(g => Object.assign({}, g, {
        id:     merge ? snafUid() : (g.id || snafUid()),
        agents: Array.isArray(g.agents) ? g.agents : [],
        active: g.active !== false
    }));

    groups = merge ? groups.concat(cleaned) : cleaned;

    if (!merge && data.rr && typeof data.rr === 'object') {
        const patch = {};
        patch[SNAF_KEY_RR] = data.rr;
        await chrome.storage.local.set(patch);
    }

    // Any users bundled with the groups are folded into the global list.
    let learned = 0;
    if (Array.isArray(data.users) && data.users.length) {
        const merged = snafMergeUsers(directory, data.users);
        directory = merged.users;
        learned   = merged.added + merged.updated;
        if (learned) await saveDirectory();
    }

    activeId = null;
    draft    = null;
    setDirty(false);
    await saveGroups();
    renderGroupList();
    renderEditor();

    toast('Imported ' + snafPlural(cleaned.length, 'group') +
          (learned ? ' and ' + snafPlural(learned, 'user') : ''), 'ok');
});

// ── Agents: the global user directory ─────────────────────────────────────────
function directoryUsage() {
    // How many directory entries are actually referenced by a group. Display
    // name counts too: an agent added by name alone, with no user ID or sys_id
    // yet, is still a reference to that person.
    const refs = new Set();
    groups.forEach(g => (g.agents || []).forEach(a => {
        if (!a) return;
        if (a.sys_id)    refs.add(a.sys_id.toLowerCase());
        if (a.user_name) refs.add(a.user_name.toLowerCase());
        if (a.name)      refs.add(a.name.toLowerCase());
    }));
    return directory.filter(u =>
        (u.sys_id    && refs.has(u.sys_id.toLowerCase())) ||
        (u.user_name && refs.has(u.user_name.toLowerCase())) ||
        (u.name      && refs.has(u.name.toLowerCase()))).length;
}

function queueDirSave() {
    clearTimeout(dirSaveTimer);
    dirSaveTimer = setTimeout(() => { saveDirectory().catch(() => {}); }, 400);
}

function renderDirectory() {
    // Drop selections for people who no longer exist, so a stale uid can't keep
    // the bulk bar showing a count that doesn't match anything.
    if (dirSelection.size) {
        const live = new Set(directory.map(u => u.uid));
        Array.from(dirSelection).forEach(uid => { if (!live.has(uid)) dirSelection.delete(uid); });
    }

    const term  = ($('dirSearch').value || '').trim().toLowerCase();
    const shown = !term ? directory : directory.filter(u =>
        [u.name, u.user_name, u.sys_id, u.email].some(v => (v || '').toLowerCase().includes(term)));

    $('dirTotal').textContent    = directory.length;
    $('dirResolved').textContent = directory.filter(u => u.sys_id).length;
    $('dirMissing').textContent  = directory.filter(u => !u.sys_id).length;
    $('dirUsed').textContent     = directoryUsage();
    $('dirShowing').textContent  = term
        ? 'Showing ' + shown.length + ' of ' + directory.length
        : snafPlural(directory.length, 'person', 'people');

    // The header checkbox is the conventional control, but a labelled button is
    // easier to find, so both are offered and both act on the filtered rows.
    const selectAllBtn = $('btnDirSelectAll');
    const allShownPicked = shown.length > 0 && shown.every(u => dirSelection.has(u.uid));
    selectAllBtn.textContent = allShownPicked ? 'Clear selection'
                             : term           ? 'Select these ' + shown.length
                             :                  'Select all';
    selectAllBtn.disabled = shown.length === 0;

    elDirTable.innerHTML = '';

    if (!directory.length) {
        const e = document.createElement('div');
        e.className = 'empty';
        e.innerHTML =
            '<div class="empty-icon">' + svgIcon(
                '<path d="M19 20v-1.8a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4V20"/><circle cx="12" cy="7.6" r="3.6"/>',
                { width: 1.5 }) + '</div>' +
            '<div class="empty-title">No users declared</div>' +
            '<div class="empty-text">Add people here once and every group can suggest them. ' +
            'You can also import a list, or let the engine fill this in as it resolves user IDs.</div>';
        elDirTable.appendChild(e);
        paintBulk();
        return;
    }

    const head = document.createElement('div');
    head.className = 'dir-row is-head';

    // Select-all sits in the header cell rather than in the toolbar, so it lines
    // up with the column of checkboxes it controls.
    const headCheck = document.createElement('div');
    headCheck.className = 'dir-check';
    const all = document.createElement('input');
    all.type = 'checkbox';
    all.id   = 'dirSelectAll';
    all.title = 'Select all';
    all.setAttribute('aria-label', 'Select all people');

    const shownPicked = shown.filter(u => dirSelection.has(u.uid)).length;
    all.checked       = shown.length > 0 && shownPicked === shown.length;
    all.indeterminate = shownPicked > 0 && shownPicked < shown.length;

    // Operates on the filtered rows, so "select all" under a search means those
    // rows and not the whole directory.
    all.addEventListener('change', () => {
        if (all.checked) shown.forEach(u => dirSelection.add(u.uid));
        else             shown.forEach(u => dirSelection.delete(u.uid));
        renderDirectory();
    });
    headCheck.appendChild(all);
    head.appendChild(headCheck);

    // Appended as direct children, matching the body rows exactly, so the
    // columns line up without a second set of flex rules to keep in step.
    [['dir-person', 'Name'], ['dir-uid', 'User ID'],
     ['dir-sys', 'sys_id'], ['dir-actions', '']].forEach(pair => {
        const cell = document.createElement('div');
        cell.className   = pair[0];
        cell.textContent = pair[1];
        head.appendChild(cell);
    });

    elDirTable.appendChild(head);

    if (!shown.length) {
        const e = document.createElement('div');
        e.className = 'list-empty';
        e.textContent = 'Nobody matches that search.';
        elDirTable.appendChild(e);
        paintBulk();
        return;
    }

    shown.forEach(u => {
        const row = document.createElement('div');
        row.className = 'dir-row';

        const chk = document.createElement('div');
        chk.className = 'dir-check';
        const cb = document.createElement('input');
        cb.type    = 'checkbox';
        cb.checked = dirSelection.has(u.uid);
        cb.setAttribute('aria-label', 'Select ' + snafUserLabel(u));
        cb.addEventListener('change', () => {
            if (cb.checked) dirSelection.add(u.uid); else dirSelection.delete(u.uid);
            paintBulk();
        });
        chk.appendChild(cb);
        row.appendChild(chk);

        const person = document.createElement('div');
        person.className = 'dir-person';
        const av = avatarEl(u.user_name || u.sys_id, u.name || u.user_name);
        const nameIn = document.createElement('input');
        nameIn.className   = 'dir-name-input';
        nameIn.value       = u.name || '';
        nameIn.placeholder = 'Full name';
        nameIn.addEventListener('input', () => {
            u.name = nameIn.value;
            av.textContent = snafInitials(u.name || u.user_name);
            queueDirSave();
        });
        person.appendChild(av);
        person.appendChild(nameIn);
        row.appendChild(person);

        const uidCell = document.createElement('div');
        uidCell.className = 'dir-uid';
        const uidIn = document.createElement('input');
        uidIn.className   = 'dir-cell-input';
        uidIn.value       = u.user_name || '';
        uidIn.placeholder = 'user ID';
        uidIn.addEventListener('input', () => { u.user_name = uidIn.value.trim(); queueDirSave(); });
        uidCell.appendChild(uidIn);
        row.appendChild(uidCell);

        const sysCell = document.createElement('div');
        sysCell.className = 'dir-sys';
        const sysIn = document.createElement('input');
        sysIn.className   = 'dir-cell-input';
        sysIn.value       = u.sys_id || '';
        sysIn.placeholder = 'not resolved yet';
        function markSys() {
            const v = sysIn.value.trim();
            sysIn.classList.toggle('is-bad', !!v && !snafIsSysId(v));
        }
        sysIn.addEventListener('input', () => {
            const v = sysIn.value.trim();
            u.sys_id = snafIsSysId(v) ? v.toLowerCase() : v;
            markSys();
            queueDirSave();
        });
        markSys();
        sysCell.appendChild(sysIn);
        row.appendChild(sysCell);

        const acts = document.createElement('div');
        acts.className = 'dir-actions';
        const del = document.createElement('button');
        del.className = 'icon-btn danger';
        del.title     = 'Remove from the global list';
        del.setAttribute('aria-label', 'Remove ' + snafUserLabel(u));
        del.innerHTML = ICON_TRASH;
        del.addEventListener('click', async () => {
            directory = directory.filter(x => x.uid !== u.uid);
            dirSelection.delete(u.uid);
            await saveDirectory();
            renderDirectory();
        });
        acts.appendChild(del);
        row.appendChild(acts);

        elDirTable.appendChild(row);
    });

    paintBulk();
}

function paintBulk() {
    const bar = $('dirBulk');
    const n   = dirSelection.size;
    bar.style.display = n ? 'flex' : 'none';
    $('dirBulkCount').textContent = n + ' selected';
}

$('dirSearch').addEventListener('input', renderDirectory);

$('btnDirSelectAll').addEventListener('click', () => {
    const term  = ($('dirSearch').value || '').trim().toLowerCase();
    const shown = !term ? directory : directory.filter(u =>
        [u.name, u.user_name, u.sys_id, u.email].some(v => (v || '').toLowerCase().includes(term)));

    if (shown.length && shown.every(u => dirSelection.has(u.uid))) {
        shown.forEach(u => dirSelection.delete(u.uid));
    } else {
        shown.forEach(u => dirSelection.add(u.uid));
    }
    renderDirectory();
});

$('btnDirAdd').addEventListener('click', async () => {
    // Built directly rather than through snafNormaliseUser, which rejects a
    // wholly empty record — here the empty row is the point.
    directory.unshift({
        uid: snafUid(), name: '', user_name: '', sys_id: '',
        email: '', note: '', addedAt: new Date().toISOString()
    });
    await saveDirectory();
    $('dirSearch').value = '';
    renderDirectory();
    const first = elDirTable.querySelector('.dir-name-input');
    if (first) first.focus();
});

$('btnDirDeleteSel').addEventListener('click', async () => {
    const n = dirSelection.size;
    if (!n) return;
    if (!confirm('Remove ' + snafPlural(n, 'person', 'people') +
                 ' from the global list? Groups that reference them are not changed.')) return;
    directory = directory.filter(u => !dirSelection.has(u.uid));
    dirSelection.clear();
    await saveDirectory();
    renderDirectory();
    toast('Removed ' + n + ' from the list');
});

function exportUsers(list, format, isAll) {
    if (format === 'csv') {
        download(
            'sn-assignflow-users-' + (isAll ? 'all' : list.length) + '-' + snafDateStamp() + '.csv',
            snafUsersToCsv(list),
            'text/csv;charset=utf-8'
        );
    } else {
        download(
            stamp(isAll ? 'users-all' : 'users-' + list.length),
            JSON.stringify({
                version: SNAF_EXPORT_VERSION,
                kind: 'users',
                exportedAt: new Date().toISOString(),
                users: list
            }, null, 2)
        );
    }
    toast('Exported ' + list.length + ' ' + (list.length === 1 ? 'person' : 'people'), 'ok');
}

$('btnDirExport').addEventListener('click', () => {
    if (!directory.length) { toast('The global list is empty', 'warn'); return; }
    openPickModal({
        title:      'Export global user list',
        items:      directory,
        withFormat: true,
        labelOf:    u => u.name || u.user_name || '(unnamed)',
        metaOf:     u => [u.user_name || 'no user ID', u.sys_id || 'no sys_id'].join('  ·  '),
        onExport:   exportUsers
    });
});

$('btnDirExportSel').addEventListener('click', () => {
    const list = directory.filter(u => dirSelection.has(u.uid));
    if (!list.length) return;
    exportUsers(list, 'json', false);
});

$('btnDirImport').addEventListener('click', async () => {
    const file = await pickFile('.json,.csv,text/csv,application/json');
    if (!file) return;

    let incoming;
    try { incoming = snafParseUserImport(file.text); }
    catch (e) { toast('Could not read that file: ' + e.message, 'err'); return; }

    if (!incoming.length) { toast('No users found in that file', 'warn'); return; }

    const merged = snafMergeUsers(directory, incoming);
    directory = merged.users;
    await saveDirectory();
    renderDirectory();

    const parts = [];
    if (merged.added)   parts.push(merged.added + ' added');
    if (merged.updated) parts.push(merged.updated + ' updated');
    toast(parts.length ? 'Import complete — ' + parts.join(', ') : 'Nothing new in that file',
          parts.length ? 'ok' : 'warn');
});

// Fills in missing sys_ids by asking a real ServiceNow tab to run the lookup.
$('btnDirResolve').addEventListener('click', async () => {
    const pending = directory.filter(u => !snafIsSysId(u.sys_id) && u.user_name);
    if (!pending.length) {
        const noId = directory.filter(u => !snafIsSysId(u.sys_id));
        toast(noId.length
            ? snafPlural(noId.length, 'entry', 'entries') + ' need a user ID before they can be resolved'
            : 'Every entry already has a sys_id', noId.length ? 'warn' : 'ok');
        return;
    }

    const btn = $('btnDirResolve');
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Resolving…';

    let res;
    try {
        res = await chrome.runtime.sendMessage({
            type: 'LOOKUP_USERS',
            terms: pending.map(u => u.user_name)
        });
    } catch (e) {
        res = { ok: false, error: String(e && e.message || e) };
    }

    btn.disabled = false;
    btn.textContent = original;

    if (!res || !res.ok) {
        if (res && res.reason === 'no_sn_tab') {
            toast('Open a ServiceNow tab first — the lookup runs through your session there', 'err');
        } else {
            toast('Lookup failed' + (res && res.error ? ': ' + res.error : ''), 'err');
        }
        return;
    }

    let filled = 0;
    let missed = 0;
    let ambiguous = 0;

    pending.forEach(u => {
        const hit = res.users[u.user_name.toLowerCase()];
        if (!hit)            { missed++; return; }
        if (hit.ambiguous)   { ambiguous++; return; }
        if (!hit.sys_id)     { missed++; return; }
        u.sys_id = hit.sys_id;
        if (!u.name  && hit.name)  u.name  = hit.name;
        if (!u.email && hit.email) u.email = hit.email;
        filled++;
    });

    if (filled) await saveDirectory();
    renderDirectory();

    const bits = [];
    if (filled)    bits.push(filled + ' resolved');
    if (missed)    bits.push(missed + ' not found');
    if (ambiguous) bits.push(ambiguous + ' ambiguous');
    toast(bits.join(', ') + (res.host ? ' · via ' + res.host : ''), filled ? 'ok' : 'warn');
});

// ── Rules ─────────────────────────────────────────────────────────────────────
function fillIntervalSelect(sel, value) {
    sel.innerHTML = '';
    SNAF_INTERVAL_STEPS.forEach(secs => {
        const o = document.createElement('option');
        o.value = String(secs);
        o.textContent = secs < 60 ? secs + ' seconds'
                      : secs === 60 ? '1 minute'
                      : (secs / 60) + ' minutes';
        sel.appendChild(o);
    });
    const nearest = SNAF_INTERVAL_STEPS.reduce((best, s) =>
        Math.abs(s - value) < Math.abs(best - value) ? s : best, SNAF_INTERVAL_STEPS[0]);
    sel.value = String(nearest);
}

function wireRules() {
    wireToggle($('ruleDryRun'),
        () => settings.rules.dryRun,
        v => { settings.rules.dryRun = v; saveSettings(); toast(v ? 'Dry run on — nothing will be written' : 'Dry run off', v ? 'warn' : 'ok'); });

    wireToggle($('ruleUnassigned'),
        () => settings.rules.requireUnassigned,
        v => { settings.rules.requireUnassigned = v; saveSettings(); if (draft) renderEditor(); });

    wireToggle($('ruleResolve'),
        () => settings.rules.resolveUserIds,
        v => { settings.rules.resolveUserIds = v; saveSettings(); });

    const maxCycle = $('ruleMaxCycle');
    maxCycle.value = settings.rules.maxPerCycle;
    maxCycle.addEventListener('change', () => {
        settings.rules.maxPerCycle = snafClampInt(maxCycle.value, 0, 10000, 0);
        maxCycle.value = settings.rules.maxPerCycle;
        saveSettings();
    });

    const maxAgent = $('ruleMaxAgent');
    maxAgent.value = settings.rules.maxPerAgentPerCycle;
    maxAgent.addEventListener('change', () => {
        settings.rules.maxPerAgentPerCycle = snafClampInt(maxAgent.value, 0, 10000, 0);
        maxAgent.value = settings.rules.maxPerAgentPerCycle;
        saveSettings();
    });

    const table = $('ruleTable');
    table.value = settings.rules.defaultTable;
    table.addEventListener('change', () => {
        const v = table.value.trim();
        settings.rules.defaultTable = v || 'incident';
        table.value = settings.rules.defaultTable;
        saveSettings();
    });

    const interval = $('ruleInterval');
    fillIntervalSelect(interval, settings.rules.defaultIntervalSecs);
    interval.addEventListener('change', () => {
        settings.rules.defaultIntervalSecs = snafClampInt(interval.value, 15, 3600, 60);
        saveSettings();
    });
}

// ── Instances (custom / on-premise hosts) ─────────────────────────────────────
// Only *.service-now.com ships in the manifest. Any other host is granted here,
// at runtime, by the user. Nothing about their employer or their instance is
// baked into the build.
function notifySyncDomains() {
    chrome.runtime.sendMessage({ type: 'SYNC_DOMAINS' }).catch(() => {});
}

async function readDomains() {
    const store = await chrome.storage.local.get([SNAF_KEY_DOMAINS, SNAF_KEY_ALLURLS]);
    return {
        allUrls:  !!store[SNAF_KEY_ALLURLS],
        patterns: Array.isArray(store[SNAF_KEY_DOMAINS]) ? store[SNAF_KEY_DOMAINS] : []
    };
}

async function hasOrigin(pattern) {
    try { return await chrome.permissions.contains({ origins: [pattern] }); }
    catch (e) { return false; }
}

async function writeDomains(patterns) {
    const patch = {};
    patch[SNAF_KEY_DOMAINS] = patterns;
    await chrome.storage.local.set(patch);
    notifySyncDomains();
}

function makeDomainRow(opts) {
    const row = document.createElement('div');
    row.className = 'domain-row' +
        (opts.builtin ? ' is-builtin' : '') +
        (opts.revoked ? ' is-revoked' : '');

    const host = document.createElement('span');
    host.className   = 'domain-host';
    host.textContent = opts.host;
    host.title       = opts.host;
    row.appendChild(host);

    const badge = document.createElement('span');
    if (opts.builtin) {
        badge.className   = 'badge brand';
        badge.textContent = 'Built in';
    } else if (opts.revoked) {
        badge.className   = 'badge warn';
        badge.textContent = 'Access revoked';
    } else {
        badge.className   = 'badge on';
        badge.textContent = 'Granted';
    }
    row.appendChild(badge);

    if (opts.revoked) {
        const again = document.createElement('button');
        again.className   = 'btn btn-secondary btn-sm';
        again.textContent = 'Grant again';
        again.addEventListener('click', () => regrantDomain(opts.pattern));
        row.appendChild(again);
    }

    if (!opts.builtin) {
        const del = document.createElement('button');
        del.className = 'icon-btn danger';
        del.title     = 'Remove ' + opts.host;
        del.setAttribute('aria-label', 'Remove ' + opts.host);
        del.innerHTML = ICON_TRASH;
        del.addEventListener('click', () => removeDomain(opts.pattern));
        row.appendChild(del);
    }

    return row;
}

async function renderDomains() {
    const state = await readDomains();

    const tog = $('allUrls');
    tog.classList.toggle('on', state.allUrls);
    tog.setAttribute('aria-checked', state.allUrls ? 'true' : 'false');

    // Naming individual domains is pointless while every site is allowed, so the
    // list is dimmed rather than removed — the entries are still there when the
    // broad grant is switched back off.
    $('domainsBox').classList.toggle('is-off', state.allUrls);

    const list = $('domainList');
    list.innerHTML = '';
    list.appendChild(makeDomainRow({ host: '*.service-now.com', builtin: true }));

    if (!state.patterns.length) {
        const empty = document.createElement('div');
        empty.className     = 'domains-empty';
        empty.style.marginTop = '8px';
        empty.textContent   = 'No additional domains yet. Add one above if your instance is hosted elsewhere.';
        list.appendChild(empty);
        return;
    }

    for (const pattern of state.patterns) {
        // A permission can be withdrawn from the browser's own settings without
        // this list knowing, so each entry is verified rather than assumed.
        const granted = state.allUrls ? true : await hasOrigin(pattern);
        list.appendChild(makeDomainRow({
            host:    snafPatternToDomain(pattern),
            pattern: pattern,
            revoked: !granted
        }));
    }
}

$('allUrls').addEventListener('click', async () => {
    const turningOn = !$('allUrls').classList.contains('on');

    if (turningOn) {
        // Has to be the first await in this handler: a permission request is only
        // honoured while the click that triggered it is still the active user
        // gesture, and any earlier await spends it.
        let granted = false;
        try { granted = await chrome.permissions.request({ origins: [SNAF_ALL_URLS] }); }
        catch (e) { granted = false; }

        if (!granted) { toast('Permission not granted', 'err'); await renderDomains(); return; }

        const patch = {};
        patch[SNAF_KEY_ALLURLS] = true;
        await chrome.storage.local.set(patch);
        notifySyncDomains();
        toast('Enabled on all websites', 'ok');
    } else {
        try { await chrome.permissions.remove({ origins: [SNAF_ALL_URLS] }); } catch (e) {}
        const patch = {};
        patch[SNAF_KEY_ALLURLS] = false;
        await chrome.storage.local.set(patch);
        notifySyncDomains();
        toast('Back to your named domains only');
    }
    await renderDomains();
});

$('btnAddDomain').addEventListener('click', async () => {
    const input   = $('newDomain');
    const pattern = snafDomainToPattern(input.value);

    if (!pattern) { toast('That does not look like a domain', 'warn'); return; }

    const host = snafPatternToDomain(pattern);
    if (snafIsServiceNowCloud(host) || host === '*.service-now.com') {
        toast('ServiceNow cloud domains are already supported', 'warn');
        input.value = '';
        return;
    }

    // Request before touching storage, for the user-gesture reason above.
    let granted = false;
    try { granted = await chrome.permissions.request({ origins: [pattern] }); }
    catch (e) { granted = false; }
    if (!granted) { toast('Permission not granted for ' + host, 'err'); return; }

    const state = await readDomains();
    if (state.patterns.indexOf(pattern) !== -1) {
        toast(host + ' is already on the list', 'warn');
        input.value = '';
        await renderDomains();
        return;
    }

    await writeDomains(state.patterns.concat([pattern]));
    input.value = '';
    await renderDomains();
    toast('Added ' + host + ' — reload any open tab on it', 'ok');
});

$('newDomain').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); $('btnAddDomain').click(); }
});

async function regrantDomain(pattern) {
    let granted = false;
    try { granted = await chrome.permissions.request({ origins: [pattern] }); }
    catch (e) { granted = false; }
    if (!granted) { toast('Still not granted', 'err'); return; }
    notifySyncDomains();
    await renderDomains();
    toast('Access restored for ' + snafPatternToDomain(pattern), 'ok');
}

async function removeDomain(pattern) {
    const host = snafPatternToDomain(pattern);
    if (!confirm('Remove ' + host + '? SN Assignflow will stop running on that instance.')) return;

    try { await chrome.permissions.remove({ origins: [pattern] }); } catch (e) {}

    const state = await readDomains();
    await writeDomains(state.patterns.filter(p => p !== pattern));
    await renderDomains();
    toast('Removed ' + host);
}

// ── Settings ──────────────────────────────────────────────────────────────────
function wireSettings() {
    wireToggle($('kaEnabled'),
        () => settings.keepAlive.enabled,
        v => { settings.keepAlive.enabled = v; saveSettings(); });

    const mins = $('kaMinutes');
    mins.value = settings.keepAlive.minutes;
    mins.addEventListener('change', () => {
        settings.keepAlive.minutes = snafClampInt(mins.value,
            SNAF_KEEPALIVE_MIN_MINUTES, SNAF_KEEPALIVE_MAX_MINUTES, SNAF_KEEPALIVE_DEFAULT_MINUTES);
        mins.value = settings.keepAlive.minutes;
        saveSettings();
    });

    wireToggle($('kaForce'),
        () => settings.keepAlive.forceWhileRunning,
        v => { settings.keepAlive.forceWhileRunning = v; saveSettings(); });

    wireToggle($('logPersist'),
        () => settings.logs.persist,
        v => { settings.logs.persist = v; saveSettings(); });

    $('themeSelect').addEventListener('change', e => setTheme(e.target.value));
    $('btnTheme').addEventListener('click', () =>
        setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));

    $('btnBackupExport').addEventListener('click', async () => {
        const store = await chrome.storage.local.get([
            SNAF_KEY_GROUPS, SNAF_KEY_USERS, SNAF_KEY_SETTINGS, SNAF_KEY_RR, SNAF_KEY_STATS
        ]);
        download(stamp('backup'), JSON.stringify({
            version:    SNAF_EXPORT_VERSION,
            kind:       'backup',
            exportedAt: new Date().toISOString(),
            groups:   store[SNAF_KEY_GROUPS]   || [],
            users:    store[SNAF_KEY_USERS]    || [],
            settings: store[SNAF_KEY_SETTINGS] || settings,
            rr:       store[SNAF_KEY_RR]       || {},
            stats:    store[SNAF_KEY_STATS]    || {}
        }, null, 2));
        toast('Backup exported', 'ok');
    });

    $('btnBackupImport').addEventListener('click', async () => {
        if (!confirmDiscard()) return;

        const file = await pickFile('.json,application/json');
        if (!file) return;

        let data;
        try { data = JSON.parse(file.text); }
        catch (e) { toast('That file is not valid JSON', 'err'); return; }

        if (!data || typeof data !== 'object' || (!data.groups && !data.users)) {
            toast('That does not look like an SN Assignflow backup', 'err');
            return;
        }
        if (!confirm('Restoring a backup replaces your current groups, user list and settings. Continue?')) return;

        const patch = {};
        if (Array.isArray(data.groups))  patch[SNAF_KEY_GROUPS]   = data.groups;
        if (Array.isArray(data.users))   patch[SNAF_KEY_USERS]    = snafNormaliseUsers(data.users);
        if (data.settings)               patch[SNAF_KEY_SETTINGS] = snafNormaliseSettings(data.settings);
        if (data.rr && typeof data.rr === 'object')       patch[SNAF_KEY_RR]    = data.rr;
        if (data.stats && typeof data.stats === 'object') patch[SNAF_KEY_STATS] = data.stats;

        await chrome.storage.local.set(patch);
        await loadAll();

        activeId = null;
        draft    = null;
        setDirty(false);
        dirSelection.clear();

        refreshEverything();
        notifyTabs();
        toast('Backup restored', 'ok');
    });

    $('btnReset').addEventListener('click', async () => {
        if (!confirm('Delete every SN Assignflow group, the global user list, all settings and the log history on this browser?')) return;
        if (!confirm('Last check — this cannot be undone. Delete everything?')) return;

        await chrome.storage.local.remove([
            SNAF_KEY_GROUPS, SNAF_KEY_USERS, SNAF_KEY_SETTINGS,
            SNAF_KEY_RR, SNAF_KEY_STATS, SNAF_KEY_LOGS, SNAF_KEY_UI
        ]);
        await loadAll();

        activeId = null;
        draft    = null;
        setDirty(false);
        dirSelection.clear();

        refreshEverything();
        notifyTabs();
        toast('All data deleted');
    });
}

// ── Logs ──────────────────────────────────────────────────────────────────────
function renderLogs() {
    const term  = ($('logFilter').value || '').trim().toLowerCase();
    const level = $('logLevel').value;

    const shown = logEntries.filter(e => {
        if (!e) return false;
        if (level && e.lv !== level) return false;
        if (term) {
            return String(e.msg || '').toLowerCase().includes(term) ||
                   String(e.host || '').toLowerCase().includes(term);
        }
        return true;
    });

    $('logCount').textContent = logEntries.length
        ? 'Showing ' + shown.length + ' of ' + logEntries.length + ' entries'
        : '';

    elLogBody.innerHTML = '';

    if (!logEntries.length) {
        const e = document.createElement('div');
        e.className = 'empty';
        e.innerHTML =
            '<div class="empty-icon">' + svgIcon(
                '<rect x="4" y="4" width="16" height="16" rx="2.2"/><path d="M8 9.5h8"/><path d="M8 13h8"/><path d="M8 16.5h5"/>',
                { width: 1.5 }) + '</div>' +
            '<div class="empty-title">Nothing logged yet</div>' +
            '<div class="empty-text">Run the dispatcher from a ServiceNow tab and its activity shows up here.' +
            (settings.logs.persist ? '' : ' Log history is currently switched off in Settings.') + '</div>';
        elLogBody.appendChild(e);
        return;
    }

    if (!shown.length) {
        const e = document.createElement('div');
        e.className = 'list-empty';
        e.textContent = 'No entry matches that filter.';
        elLogBody.appendChild(e);
        return;
    }

    // Newest first: the interesting end of a long log is the recent end.
    shown.slice().reverse().forEach(entry => {
        const line = document.createElement('div');
        line.className = 'log-line' + (entry.lv ? ' lv-' + entry.lv : '');

        const when = document.createElement('span');
        when.className = 'log-when';
        const d = new Date(entry.t || 0);
        when.textContent = snafDateStamp(d) + ' ' + snafTimestamp(d);

        const host = document.createElement('span');
        host.className   = 'log-host';
        host.textContent = entry.host || '';
        host.title       = entry.host || '';

        const msg = document.createElement('span');
        msg.className   = 'log-msg';
        msg.textContent = entry.msg || '';

        line.appendChild(when);
        line.appendChild(host);
        line.appendChild(msg);
        elLogBody.appendChild(line);
    });
}

$('logFilter').addEventListener('input', renderLogs);
$('logLevel').addEventListener('change', renderLogs);

$('btnLogRefresh').addEventListener('click', async () => {
    const store = await chrome.storage.local.get(SNAF_KEY_LOGS);
    logEntries = Array.isArray(store[SNAF_KEY_LOGS]) ? store[SNAF_KEY_LOGS] : [];
    renderLogs();
    toast('Log refreshed');
});

$('btnLogExport').addEventListener('click', () => {
    if (!logEntries.length) { toast('There is nothing to export', 'warn'); return; }
    const text = logEntries.map(e =>
        [snafDateStamp(new Date(e.t || 0)) + ' ' + snafTimestamp(new Date(e.t || 0)),
         e.host || '-', (e.lv || 'info').toUpperCase(), e.msg || ''].join('\t')
    ).join('\n');
    download('sn-assignflow-log-' + snafDateStamp() + '.txt', text, 'text/plain;charset=utf-8');
    toast('Log exported', 'ok');
});

$('btnLogClear').addEventListener('click', async () => {
    if (!logEntries.length) return;
    if (!confirm('Clear the stored log history?')) return;
    await chrome.storage.local.remove(SNAF_KEY_LOGS);
    logEntries = [];
    renderLogs();
    toast('Log cleared');
});

// ── About ─────────────────────────────────────────────────────────────────────
async function renderAbout() {
    let manifest = {};
    try { manifest = chrome.runtime.getManifest(); } catch (e) {}

    $('aboutVer').textContent   = 'Version ' + (manifest.version || '4.0.0');
    $('railVersion').textContent = 'v' + (manifest.version || '4.0.0');

    // Built-in hosts come from the manifest; anything else was granted by the
    // user at runtime, so it has to be read from storage rather than the build.
    const builtIn = (manifest.host_permissions || []).join(', ') || 'None declared';
    let hostText  = builtIn + ' (built in)';
    try {
        const state = await readDomains();
        if (state.allUrls) {
            hostText += ' · all websites (granted by you)';
        } else if (state.patterns.length) {
            hostText += ' · ' + state.patterns.map(snafPatternToDomain).join(', ') + ' (added by you)';
        }
    } catch (e) { /* the built-in list is still worth showing */ }
    $('aboutHosts').textContent = hostText;

    const el = $('aboutStorage');
    try {
        if (chrome.storage.local.getBytesInUse) {
            const bytes = await chrome.storage.local.getBytesInUse(null);
            el.textContent = (bytes / 1024).toFixed(1) + ' KB';
        } else {
            // Firefox does not implement getBytesInUse for storage.local.
            const all = await chrome.storage.local.get(null);
            el.textContent = (JSON.stringify(all).length / 1024).toFixed(1) + ' KB (approximate)';
        }
    } catch (e) {
        el.textContent = 'Unavailable';
    }
}

// ── Refresh everything ────────────────────────────────────────────────────────
function refreshEverything() {
    paintCounts();
    renderGroupList();
    renderEditor();
    renderDirectory();
    renderLogs();
    renderDomains().catch(() => {});

    // Re-seed the controls that hold their value in the DOM.
    $('ruleMaxCycle').value = settings.rules.maxPerCycle;
    $('ruleMaxAgent').value = settings.rules.maxPerAgentPerCycle;
    $('ruleTable').value    = settings.rules.defaultTable;
    fillIntervalSelect($('ruleInterval'), settings.rules.defaultIntervalSecs);
    $('kaMinutes').value    = settings.keepAlive.minutes;

    [['ruleDryRun', settings.rules.dryRun],
     ['ruleUnassigned', settings.rules.requireUnassigned],
     ['ruleResolve', settings.rules.resolveUserIds],
     ['kaEnabled', settings.keepAlive.enabled],
     ['kaForce', settings.keepAlive.forceWhileRunning],
     ['logPersist', settings.logs.persist]].forEach(pair => {
        const el = $(pair[0]);
        el.classList.toggle('on', !!pair[1]);
        el.setAttribute('aria-checked', pair[1] ? 'true' : 'false');
    });
}

// Keep the page honest when another surface changes the same data.
//
// storage.onChanged also fires for this page's own writes, and re-rendering on
// those would steal focus out of the field being typed into. Rather than a
// suppression counter, which drifts out of step the moment a write fails, the
// incoming value is compared against what is already in memory: identical means
// this page caused it, so there is nothing to do.
function sameJson(a, b) {
    try { return JSON.stringify(a) === JSON.stringify(b); }
    catch (e) { return false; }
}

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (changes[SNAF_KEY_LOGS]) {
        const next = Array.isArray(changes[SNAF_KEY_LOGS].newValue) ? changes[SNAF_KEY_LOGS].newValue : [];
        if (!sameJson(next, logEntries)) {
            logEntries = next;
            if (section === 'logs') renderLogs();
        }
    }

    // The engine caches resolved sys_ids back into the directory as it runs.
    if (changes[SNAF_KEY_USERS]) {
        const raw = changes[SNAF_KEY_USERS].newValue;
        if (!sameJson(raw, directory)) {
            directory = snafNormaliseUsers(raw);
            paintCounts();
            if (section === 'agents') renderDirectory();
        }
    }

    if (changes[SNAF_KEY_GROUPS]) {
        const next = Array.isArray(changes[SNAF_KEY_GROUPS].newValue) ? changes[SNAF_KEY_GROUPS].newValue : [];
        // An unsaved draft always wins — a background write must not silently
        // discard what is on screen.
        if (!dirty && !sameJson(next, groups)) {
            groups = next;
            paintCounts();
            if (section === 'groups') renderGroupList();
        }
    }
});

// ── Init ──────────────────────────────────────────────────────────────────────
(async function init() {
    await loadAll();

    wireRules();
    wireSettings();

    paintCounts();
    renderGroupList();
    renderEditor();

    // Not flagged as coming from the hash: go() short-circuits on a no-op
    // navigation, and the first call has to actually paint the section.
    go(location.hash.slice(1) || 'groups');
})().catch(e => {
    toast('Could not load your configuration: ' + (e && e.message || e), 'err');
});
