#!/usr/bin/env node
'use strict';

// SN Assignflow — build checks
//
// Runs on a bare Node install: no npm install, no dependencies. Validates the
// things that break silently in an extension, where there is no compiler and a
// typo in an element id or a message name simply does nothing at runtime.
//
//   node tools/check-wiring.js
//
// Exits non-zero if anything fails, so it can gate a release.

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT    = path.resolve(__dirname, '..');
const CHROME  = path.join(ROOT, 'chrome');
const FIREFOX = path.join(ROOT, 'firefox');

let failures = 0;
let warnings = 0;

function fail(msg)  { failures++; console.log('  FAIL  ' + msg); }
function warn(msg)  { warnings++; console.log('  WARN  ' + msg); }
function pass(msg)  { console.log('  ok    ' + msg); }
function head(msg)  { console.log('\n' + msg); }

function read(file) {
    try { return fs.readFileSync(file, 'utf8'); }
    catch (e) { return null; }
}

function exists(file) {
    try { return fs.statSync(file).isFile(); }
    catch (e) { return false; }
}

// Files shared byte-for-byte between the two builds.
const SHARED_FILES = [
    'shared.js', 'background.js', 'widget.js', 'widget.css', 'theme.css',
    'popup.html', 'popup.css', 'popup.js',
    'config.html', 'config.css', 'config.js',
    'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png'
];

// Which scripts each HTML page loads. Used for element-id resolution.
const PAGES = {
    'popup.html':  ['shared.js', 'popup.js'],
    'config.html': ['shared.js', 'config.js']
};

// ── 0. Company references ────────────────────────────────────────────────────
// Nothing shipped, and nothing in the documentation, may name a customer or an
// employer. On-premise instances are added by the user at runtime instead of
// being compiled into the manifest, so there is never a reason for one to appear.
//
// tools/ is deliberately not scanned — this file has to be able to hold the list.
head('Company references');

(function checkForbidden() {
    const FORBIDDEN = ['mercedes', 'benz', 'daimler', 'infosys'];
    const SKIP_EXT  = /\.(png|jpg|jpeg|gif|webp|ico|zip|xpi|crx|woff2?|ttf)$/i;

    const targets = [];
    function walk(dir, rel) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch (e) { return; }
        entries.forEach(entry => {
            const full = path.join(dir, entry.name);
            const r    = rel ? rel + '/' + entry.name : entry.name;
            if (entry.isDirectory()) { walk(full, r); return; }
            if (SKIP_EXT.test(entry.name)) return;
            targets.push({ full, rel: r });
        });
    }

    walk(CHROME,  'chrome');
    walk(FIREFOX, 'firefox');
    walk(path.join(ROOT, 'docs'), 'docs');
    ['README.md', 'CHANGELOG.md', 'privacy.html', 'LICENSE', '.gitignore'].forEach(f => {
        const full = path.join(ROOT, f);
        if (exists(full)) targets.push({ full, rel: f });
    });

    let bad = 0;
    targets.forEach(t => {
        const src   = read(t.full);
        if (src === null) return;
        const lines = src.split(/\r?\n/);
        FORBIDDEN.forEach(word => {
            lines.forEach((line, i) => {
                if (line.toLowerCase().indexOf(word) === -1) return;
                fail(t.rel + ':' + (i + 1) + ' mentions "' + word + '" — ' + line.trim().slice(0, 70));
                bad++;
            });
        });
    });

    if (!bad) pass('no company name appears in any of the ' + targets.length + ' shipped and documented files');
})();

// ── 1. Manifests ──────────────────────────────────────────────────────────────
head('Manifests');

const manifests = {};
[['chrome', CHROME], ['firefox', FIREFOX]].forEach(([label, dir]) => {
    const file = path.join(dir, 'manifest.json');
    const raw  = read(file);
    if (raw === null) { fail(label + '/manifest.json is missing'); return; }
    try {
        manifests[label] = JSON.parse(raw);
        pass(label + '/manifest.json parses');
    } catch (e) {
        fail(label + '/manifest.json is not valid JSON — ' + e.message);
    }
});

if (manifests.chrome && manifests.firefox) {
    const c = manifests.chrome;
    const f = manifests.firefox;

    if (c.version !== f.version) fail('version differs: chrome ' + c.version + ' vs firefox ' + f.version);
    else pass('version matches in both manifests (' + c.version + ')');

    if (c.name !== f.name) fail('name differs between manifests');
    else pass('name matches ("' + c.name + '")');

    if (c.name !== 'SN Assignflow') fail('name should be "SN Assignflow", found "' + c.name + '"');

    [['chrome', c], ['firefox', f]].forEach(([label, m]) => {
        if (m.manifest_version !== 3) fail(label + ' is not Manifest V3');
        if (m.browser_action)         fail(label + ' still declares browser_action (Manifest V2 leftover)');
        if (!m.action)                fail(label + ' has no action (toolbar popup)');
        if (!Array.isArray(m.host_permissions) || !m.host_permissions.length) {
            fail(label + ' declares no host_permissions');
        }
        if (Array.isArray(m.permissions)) {
            const hostish = m.permissions.filter(p => p.includes('://'));
            if (hostish.length) fail(label + ' puts host matches in permissions (belongs in host_permissions): ' + hostish.join(', '));
        }
        ['storage', 'tabs', 'scripting'].forEach(p => {
            if (!(m.permissions || []).includes(p)) fail(label + ' is missing the "' + p + '" permission');
        });
    });

    if (!c.background || c.background.service_worker !== 'background.js') {
        fail('chrome background must be { service_worker: "background.js" }');
    } else pass('chrome uses a service worker');

    // The list may legitimately carry shared.js ahead of background.js — an
    // event page has no importScripts, so it loads dependencies this way. The
    // ordering itself is asserted in the shared.js contract section below.
    if (!f.background || !Array.isArray(f.background.scripts) ||
        f.background.scripts.indexOf('background.js') === -1) {
        fail('firefox background.scripts must include background.js');
    } else pass('firefox uses an event-page background script');

    const gecko = f.browser_specific_settings && f.browser_specific_settings.gecko;
    if (!gecko || !gecko.id) fail('firefox manifest has no gecko id');
    else pass('firefox gecko id is ' + gecko.id);

    if (c.browser_specific_settings) warn('chrome manifest carries browser_specific_settings (harmless, but unused)');

    // Exactly one host is built in: ServiceNow's own cloud domain. Any other
    // instance is granted by the user at runtime through Settings → Instances,
    // so no customer or employer domain may appear in a manifest.
    const CLOUD = '*://*.service-now.com/*';
    [['chrome', c], ['firefox', f]].forEach(([label, m]) => {
        const hosts = m.host_permissions || [];
        if (hosts.length !== 1 || hosts[0] !== CLOUD) {
            fail(label + ' host_permissions must be exactly ["' + CLOUD + '"], found ' + JSON.stringify(hosts));
        } else pass(label + ' declares only the ServiceNow cloud host');

        const matches = [].concat.apply([], (m.content_scripts || []).map(cs => cs.matches || []));
        if (matches.length !== 1 || matches[0] !== CLOUD) {
            fail(label + ' content_scripts.matches must be exactly ["' + CLOUD + '"], found ' + JSON.stringify(matches));
        }

        const optional = m.optional_host_permissions || [];
        if (optional.indexOf('<all_urls>') === -1) {
            fail(label + ' must declare <all_urls> in optional_host_permissions for on-premise support');
        } else pass(label + ' offers <all_urls> as an opt-in permission');
    });
}

// ── 2. Files referenced by the manifests exist ────────────────────────────────
head('Files referenced by the manifests');

[['chrome', CHROME], ['firefox', FIREFOX]].forEach(([label, dir]) => {
    const m = manifests[label];
    if (!m) return;

    const refs = [];
    if (m.background && m.background.service_worker) refs.push(m.background.service_worker);
    if (m.background && Array.isArray(m.background.scripts)) refs.push.apply(refs, m.background.scripts);
    if (m.options_ui && m.options_ui.page) refs.push(m.options_ui.page);
    if (m.action && m.action.default_popup) refs.push(m.action.default_popup);
    Object.values((m.action && m.action.default_icon) || {}).forEach(v => refs.push(v));
    Object.values(m.icons || {}).forEach(v => refs.push(v));
    (m.content_scripts || []).forEach(cs => {
        (cs.js  || []).forEach(v => refs.push(v));
        (cs.css || []).forEach(v => refs.push(v));
    });

    let bad = 0;
    refs.forEach(rel => {
        if (!exists(path.join(dir, rel))) { fail(label + '/' + rel + ' is referenced by the manifest but missing'); bad++; }
    });
    if (!bad) pass(label + ': all ' + refs.length + ' referenced files exist');
});

// ── 3. Files referenced by the HTML pages exist ───────────────────────────────
head('Files referenced by the HTML pages');

Object.keys(PAGES).forEach(page => {
    const src = read(path.join(CHROME, page));
    if (src === null) { fail('chrome/' + page + ' is missing'); return; }

    const refs = [];
    let m;
    const scriptRe = /<script[^>]+src="([^"]+)"/g;
    while ((m = scriptRe.exec(src))) refs.push(m[1]);
    const linkRe = /<link[^>]+href="([^"]+)"/g;
    while ((m = linkRe.exec(src))) refs.push(m[1]);

    let bad = 0;
    refs.forEach(rel => {
        if (/^https?:/i.test(rel)) { fail(page + ' loads a remote resource: ' + rel); bad++; return; }
        if (!exists(path.join(CHROME, rel))) { fail(page + ' references missing file ' + rel); bad++; }
    });

    // The declared script list has to match what the page actually loads, or the
    // element-id check below is validating the wrong thing.
    const declared = PAGES[page].slice().sort().join(',');
    const actual   = refs.filter(r => r.endsWith('.js')).sort().join(',');
    if (declared !== actual) {
        fail(page + ' loads [' + actual + '] but check-wiring expects [' + declared + ']');
        bad++;
    }

    if (!bad) pass(page + ': ' + refs.length + ' references resolve');
});

// ── 4. Syntax of every JavaScript file ───────────────────────────────────────
head('JavaScript syntax');

const JS_FILES = SHARED_FILES.filter(f => f.endsWith('.js'));
JS_FILES.forEach(rel => {
    const src = read(path.join(CHROME, rel));
    if (src === null) { fail('chrome/' + rel + ' is missing'); return; }
    try {
        new vm.Script(src, { filename: rel });
        pass(rel + ' parses');
    } catch (e) {
        fail(rel + ' — ' + e.message);
    }
});

// ── 5. Element ids ───────────────────────────────────────────────────────────
head('Element ids');

function idsInHtml(src) {
    const out = new Set();
    let m;
    const re = /\sid="([A-Za-z0-9_-]+)"/g;
    while ((m = re.exec(src))) out.add(m[1]);
    return out;
}

// Ids the script creates itself, either via .id = '…' or inside a markup string.
function idsCreatedInJs(src) {
    const out = new Set();
    let m;
    const assign = /\.id\s*=\s*'([A-Za-z0-9_-]+)'/g;
    while ((m = assign.exec(src))) out.add(m[1]);
    const inMarkup = /\bid="([A-Za-z0-9_-]+)"/g;
    while ((m = inMarkup.exec(src))) out.add(m[1]);
    return out;
}

// Both document.getElementById('…') and the local $('…') shorthand.
//
// Only lookups against `document` count. A lookup against some other node —
// snafLooksLikeServiceNow probing a ServiceNow page for #gsft_main, for
// instance — concerns a DOM we do not own and must not be validated against our
// own markup.
function idLookupsInJs(src) {
    const out = new Set();
    let m;
    const direct = /(?:^|[^.\w$])document\.getElementById\(\s*'([A-Za-z0-9_-]+)'\s*\)/g;
    while ((m = direct.exec(src))) out.add(m[1]);
    const dollar = /(?:^|[^.\w$])\$\(\s*'([A-Za-z0-9_-]+)'\s*\)/g;
    while ((m = dollar.exec(src))) out.add(m[1]);
    return out;
}

Object.keys(PAGES).forEach(page => {
    const html = read(path.join(CHROME, page));
    if (html === null) return;

    const available = idsInHtml(html);
    const scripts   = PAGES[page];

    scripts.forEach(js => {
        const src = read(path.join(CHROME, js));
        if (src === null) return;
        idsCreatedInJs(src).forEach(id => available.add(id));
    });

    let bad = 0;
    scripts.forEach(js => {
        const src = read(path.join(CHROME, js));
        if (src === null) return;
        idLookupsInJs(src).forEach(id => {
            if (!available.has(id)) { fail(js + ' looks up #' + id + ', absent from ' + page); bad++; }
        });
    });
    if (!bad) pass(page + ' ↔ ' + scripts.join(' + ') + ': every id resolves');
});

// widget.js builds its own DOM, so it is checked against its own template.
(function checkWidgetIds() {
    const src = read(path.join(CHROME, 'widget.js'));
    if (src === null) return;
    const available = idsCreatedInJs(src);
    let bad = 0;
    idLookupsInJs(src).forEach(id => {
        if (!available.has(id)) { fail('widget.js looks up #' + id + ', which its template never creates'); bad++; }
    });
    if (!bad) pass('widget.js: every id it looks up exists in its own template');
})();

// ── 6. Message wiring ────────────────────────────────────────────────────────
head('Message wiring');

(function checkMessages() {
    const sent     = new Map();   // type -> files that send it
    const handled  = new Set();

    JS_FILES.forEach(rel => {
        const src = read(path.join(CHROME, rel));
        if (src === null) return;

        let m;
        // Anything passed as { type: 'X' } to a sendMessage call.
        const sendRe = /sendMessage\(\s*(?:[^,()]+,\s*)?\{\s*type:\s*'([A-Z_]+)'/g;
        while ((m = sendRe.exec(src))) {
            if (!sent.has(m[1])) sent.set(m[1], new Set());
            sent.get(m[1]).add(rel);
        }

        const caseRe = /case\s*'([A-Z_]+)'\s*:/g;
        while ((m = caseRe.exec(src))) handled.add(m[1]);

        const cmpRe = /msg\.type\s*===\s*'([A-Z_]+)'/g;
        while ((m = cmpRe.exec(src))) handled.add(m[1]);
    });

    if (!sent.size) { fail('no sendMessage calls found — the regex or the code changed shape'); return; }

    let bad = 0;
    sent.forEach((files, type) => {
        if (!handled.has(type)) {
            fail("message '" + type + "' is sent by " + Array.from(files).join(', ') + ' but nothing handles it');
            bad++;
        }
    });
    if (!bad) pass('all ' + sent.size + ' message types have a handler: ' + Array.from(sent.keys()).sort().join(', '));

    // A handler with no sender is dead weight, though not an error.
    handled.forEach(type => {
        if (!sent.has(type)) warn("message '" + type + "' is handled but never sent");
    });
})();

// ── 7. shared.js contract ────────────────────────────────────────────────────
head('shared.js contract');

(function checkShared() {
    const src = read(path.join(CHROME, 'shared.js'));
    if (src === null) { fail('chrome/shared.js is missing'); return; }

    // Shared functions are snaf + CapitalisedName; shared constants are SNAF_*.
    // Requiring the capital is what keeps CSS class names like "snaf-log-line"
    // out of the match.
    const IDENT = /\b(snaf[A-Z][A-Za-z0-9_]*|SNAF_[A-Z0-9_]+)\b/g;

    const defined = new Set();
    let m;
    const fnRe = /^function\s+(snaf[A-Z][A-Za-z0-9_]*)/gm;
    while ((m = fnRe.exec(src))) defined.add(m[1]);
    const varRe = /^var\s+(SNAF_[A-Z0-9_]+)/gm;
    while ((m = varRe.exec(src))) defined.add(m[1]);

    pass('shared.js exports ' + defined.size + ' identifiers');

    const consumers = ['widget.js', 'config.js', 'popup.js'];
    let bad = 0;
    consumers.forEach(rel => {
        const csrc = read(path.join(CHROME, rel));
        if (csrc === null) return;

        const used = new Set();
        const useRe = new RegExp(IDENT.source, 'g');
        while ((m = useRe.exec(csrc))) used.add(m[1]);

        used.forEach(name => {
            // Names defined locally in the consumer are its own business.
            const localFn  = new RegExp('function\\s+' + name + '\\b').test(csrc);
            const localVar = new RegExp('(?:const|let|var)\\s+' + name + '\\b').test(csrc);
            if (localFn || localVar) return;
            if (!defined.has(name)) { fail(rel + ' uses ' + name + ', which shared.js does not define'); bad++; }
        });
    });
    if (!bad) pass('every shared identifier used by the popup, widget and config page is defined');

    // background.js does use shared.js, but the two browsers load it by
    // different mechanisms so the same file has to satisfy both: Chrome's
    // classic service worker pulls it in with importScripts, and Firefox's
    // event page lists it first in background.scripts. Both halves must hold or
    // background.js throws a ReferenceError on one browser only.
    const bsrc = read(path.join(CHROME, 'background.js'));
    if (bsrc) {
        const usesShared = new RegExp(IDENT.source, 'g').test(bsrc);
        const guarded    = /typeof\s+importScripts\s*===\s*'function'\s*\)\s*importScripts\('shared\.js'\)/.test(bsrc);

        if (usesShared && !guarded) {
            fail("background.js uses shared.js but lacks the guarded importScripts('shared.js') call");
        } else if (guarded) {
            pass('background.js loads shared.js behind an importScripts guard');
        }

        const fbg = manifests.firefox && manifests.firefox.background;
        const fscripts = (fbg && fbg.scripts) || [];
        if (usesShared) {
            if (fscripts.indexOf('shared.js') === -1) {
                fail('firefox background.scripts must include shared.js — importScripts does not exist on an event page');
            } else if (fscripts.indexOf('shared.js') > fscripts.indexOf('background.js')) {
                fail('firefox background.scripts must list shared.js before background.js');
            } else {
                pass('firefox background.scripts loads shared.js before background.js');
            }
        }
    }

    // Content scripts load shared.js before widget.js, or nothing works.
    const cs = manifests.chrome && (manifests.chrome.content_scripts || [])[0];
    if (cs && Array.isArray(cs.js)) {
        if (cs.js.indexOf('shared.js') === -1 || cs.js.indexOf('shared.js') > cs.js.indexOf('widget.js')) {
            fail('content_scripts must list shared.js before widget.js');
        } else pass('content_scripts loads shared.js before widget.js');
    }
})();

// ── 8. Behavioural guarantees ────────────────────────────────────────────────
head('Behavioural guarantees');

(function checkBehaviour() {
    const shared = read(path.join(CHROME, 'shared.js')) || '';
    const widget = read(path.join(CHROME, 'widget.js')) || '';
    const config = read(path.join(CHROME, 'config.js')) || '';

    // Keep-alive must never point at an absolute URL: each tab pings its own
    // instance and nothing else.
    const epMatch = shared.match(/SNAF_KEEPALIVE_ENDPOINTS\s*=\s*\[([^\]]+)\]/);
    if (!epMatch) fail('SNAF_KEEPALIVE_ENDPOINTS not found in shared.js');
    else {
        const eps = epMatch[1].match(/'([^']+)'/g) || [];
        const absolute = eps.filter(e => /https?:|\/\//.test(e));
        if (absolute.length) fail('keep-alive endpoints must be instance-relative: ' + absolute.join(', '));
        else pass('all ' + eps.length + ' keep-alive endpoints are instance-relative');
    }

    if (!/location\.origin\s*\+\s*endpoint/.test(widget)) {
        fail('the keep-alive ping does not look instance-relative in widget.js');
    } else pass('keep-alive pings location.origin of the current tab');

    // Under an all-sites grant the content script runs everywhere, so the ping
    // must be gated on the page actually being an instance. Without this the
    // extension would hit /api/now/session on unrelated servers.
    if (!/function keepAliveWanted\(\)\s*\{[\s\S]{0,400}?snTrusted !== true\)\s*return false/.test(widget)) {
        fail('keepAliveWanted() must return false unless the page is a confirmed ServiceNow instance');
    } else pass('keep-alive only runs on a confirmed ServiceNow instance');

    if (!/function resolveTrust\(\)/.test(widget)) {
        fail('widget.js has no resolveTrust() — nothing decides whether a page is an instance');
    } else pass('widget.js resolves instance trust before acting');

    // The reported bug: clicking the panel header used to collapse it. The
    // header must be a drag handle only.
    if (/snaf-head'\)\.addEventListener\('click'/.test(widget)) {
        fail('widget.js attaches a click handler to the panel header — that is the collapse-on-click bug');
    } else pass('the panel header has no click-to-collapse handler');

    ['snaf-min', 'snaf-close'].forEach(id => {
        if (widget.indexOf("'" + id + "'") === -1) fail('widget.js has no #' + id + ' control');
    });
    if (/elMin\.addEventListener\('click'/.test(widget) && /elClose\.addEventListener\('click'/.test(widget)) {
        pass('minimise and close are separate explicit controls');
    } else {
        fail('minimise and close are not both wired as explicit controls');
    }

    // Dry run has to be inert. If it ever reached apiPatch it would be a
    // silently destructive setting.
    if (!/if\s*\(dry\)\s*\{/.test(widget)) warn('could not confirm the dry-run short-circuit in widget.js');
    else pass('dry run short-circuits before the write');

    // No remote code or remote assets anywhere.
    [['shared.js', shared], ['widget.js', widget], ['config.js', config]].forEach(([rel, src]) => {
        const urls = src.match(/https?:\/\/[^\s'"`)]+/g) || [];
        // w3.org appears in SVG namespaces, github.com is the project link, and
        // example.* only ever shows up in a comment illustrating input.
        const bad  = urls.filter(u =>
            !/^https?:\/\/www\.w3\.org/.test(u) &&
            !/github\.com/.test(u) &&
            !/example\.(?:com|org|net)\b/.test(u));
        if (bad.length) fail(rel + ' contains a remote URL: ' + bad.slice(0, 3).join(', '));
    });
    pass('no remote code or remote assets referenced');

    // The old browser.* namespace would break Chrome outright.
    JS_FILES.forEach(rel => {
        const src = read(path.join(CHROME, rel)) || '';
        const hits = src.match(/(?<![A-Za-z0-9_.])browser\.(runtime|storage|tabs|scripting)\b/g);
        if (hits) fail(rel + ' still uses the browser.* namespace (' + hits.length + ' times) — Chrome has no such global');
    });
    pass('every file uses the chrome.* namespace');

    // Storage keys carried over from 3.x must not be renamed, or upgrading
    // users silently lose their configuration.
    [['SNAF_KEY_GROUPS', 'snDispatcherGroups'],
     ['SNAF_KEY_STATS',  'snDispatcherStats'],
     ['SNAF_KEY_RR',     'snDispatcherRR'],
     ['SNAF_KEY_THEME',  'snDispatcherTheme']].forEach(([name, value]) => {
        const re = new RegExp('var\\s+' + name + "\\s*=\\s*'" + value + "'");
        if (!re.test(shared)) fail(name + " must stay '" + value + "' so 3.x configurations still load");
    });
    pass('storage keys inherited from AssignFlow 3.x are unchanged');

    // Keep-alive defaults on: the user asked for the session to stay alive.
    if (!/keepAlive:\s*\{\s*\n\s*enabled:\s*true/.test(shared)) {
        fail('keep-alive should default to enabled');
    } else pass('keep-alive defaults to on');

    if (!/forceWhileRunning:\s*true/.test(shared)) {
        fail('keep-alive forceWhileRunning should default to true');
    } else pass('keep-alive is forced on while the engine runs');
})();

// ── 9. Stylesheet coverage ───────────────────────────────────────────────────
// Catches the classic renaming failure: a selector left pointing at an id or
// class that no longer exists anywhere, which is silent at runtime and shows up
// only as an unstyled element.
head('Stylesheet coverage');

(function checkCss() {
    const scopes = [
        { css: 'widget.css', sources: ['widget.js'] },
        { css: 'popup.css',  sources: ['popup.html', 'popup.js'] },
        { css: 'config.css', sources: ['config.html', 'config.js'] }
    ];

    // Strip anything that can contain a # or . but isn't a selector.
    function selectorText(src) {
        return src
            .replace(/\/\*[\s\S]*?\*\//g, ' ')
            .replace(/url\([^)]*\)/g, ' ')
            .replace(/"[^"]*"/g, ' ')
            .replace(/'[^']*'/g, ' ');
    }

    const looksHex = name => /^[0-9a-fA-F]{3,8}$/.test(name);

    // Some class names are built by concatenation — `'lv-' + level` produces
    // lv-ok, lv-warn and so on, so the full name never appears as a literal.
    // A hyphenated stem present in the source counts as coverage.
    function covered(name, haystack) {
        if (haystack.indexOf(name) !== -1) return true;
        for (let cut = name.length - 1; cut >= 3; cut--) {
            if (name[cut - 1] !== '-') continue;
            if (haystack.indexOf(name.slice(0, cut)) !== -1) return true;
        }
        return false;
    }

    scopes.forEach(scope => {
        const css = read(path.join(CHROME, scope.css));
        if (css === null) { fail('chrome/' + scope.css + ' is missing'); return; }

        const haystack = scope.sources
            .map(rel => read(path.join(CHROME, rel)) || '')
            .join('\n');
        if (!haystack) { fail(scope.css + ': none of its sources could be read'); return; }

        const clean = selectorText(css);
        const dead  = [];

        const idRe = /#([A-Za-z][\w-]*)/g;
        let m;
        while ((m = idRe.exec(clean))) {
            const name = m[1];
            if (looksHex(name)) continue;                 // a colour, not a selector
            if (!covered(name, haystack)) dead.push('#' + name);
        }

        const clsRe = /\.([A-Za-z][\w-]*)/g;
        while ((m = clsRe.exec(clean))) {
            const name = m[1];
            if (!covered(name, haystack)) dead.push('.' + name);
        }

        const unique = Array.from(new Set(dead));
        if (unique.length) {
            fail(scope.css + ' targets ' + unique.length + ' selector(s) absent from ' +
                 scope.sources.join(' + ') + ': ' + unique.slice(0, 8).join(', ') +
                 (unique.length > 8 ? ', …' : ''));
        } else {
            pass(scope.css + ': every id and class it targets exists in ' + scope.sources.join(' + '));
        }
    });

    // theme.css is shared by both pages, so it is checked against both together.
    const theme = read(path.join(CHROME, 'theme.css'));
    if (theme !== null) {
        const haystack = ['popup.html', 'popup.js', 'config.html', 'config.js', 'widget.js']
            .map(rel => read(path.join(CHROME, rel)) || '').join('\n');
        const clean = selectorText(theme);
        const dead  = [];
        let m;
        const clsRe = /\.([A-Za-z][\w-]*)/g;
        while ((m = clsRe.exec(clean))) {
            if (!covered(m[1], haystack)) dead.push('.' + m[1]);
        }
        const unique = Array.from(new Set(dead));
        if (unique.length) fail('theme.css defines unused classes: ' + unique.slice(0, 8).join(', ') +
                                (unique.length > 8 ? ', …' : ''));
        else pass('theme.css: every class it defines is used somewhere');
    }
})();

// ── 10. Build drift ──────────────────────────────────────────────────────────
head('Build drift between chrome/ and firefox/');

(function checkDrift() {
    const crypto = require('crypto');
    const hash = file => {
        try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
        catch (e) { return null; }
    };

    let drifted = 0;
    SHARED_FILES.forEach(rel => {
        const a = hash(path.join(CHROME,  rel.replace('/', path.sep)));
        const b = hash(path.join(FIREFOX, rel.replace('/', path.sep)));
        if (a === null) { fail('chrome/' + rel + ' is missing'); drifted++; return; }
        if (b === null) { fail('firefox/' + rel + ' is missing — run tools/sync-firefox.ps1'); drifted++; return; }
        if (a !== b)    { fail('firefox/' + rel + ' differs from chrome/ — run tools/sync-firefox.ps1'); drifted++; }
    });
    if (!drifted) pass('all ' + SHARED_FILES.length + ' shared files are identical in both builds');

    // manifest.json is the one file that is meant to differ.
    const cm = read(path.join(CHROME, 'manifest.json'));
    const fm = read(path.join(FIREFOX, 'manifest.json'));
    if (cm && fm && cm === fm) fail('the two manifests are identical — the Firefox one needs its own background and gecko settings');
    else if (cm && fm) pass('manifest.json differs between builds, as intended');
})();

// ── 10. Icons ────────────────────────────────────────────────────────────────
head('Icons');

(function checkIcons() {
    let bad = 0;
    [16, 48, 128].forEach(size => {
        const file = path.join(CHROME, 'icons', 'icon' + size + '.png');
        if (!exists(file)) { fail('chrome/icons/icon' + size + '.png is missing'); bad++; return; }

        const buf = fs.readFileSync(file);
        if (buf.length < 100) { fail('icon' + size + '.png is suspiciously small'); bad++; return; }

        // PNG signature, then the IHDR width/height as big-endian uint32s.
        if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') { fail('icon' + size + '.png is not a PNG'); bad++; return; }
        const w = buf.readUInt32BE(16);
        const h = buf.readUInt32BE(20);
        if (w !== size || h !== size) { fail('icon' + size + '.png is ' + w + 'x' + h + ', expected ' + size + 'x' + size); bad++; }
    });
    if (!bad) pass('icon16, icon48 and icon128 are valid PNGs at their declared sizes');
})();

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('');
console.log('─'.repeat(64));
if (failures) {
    console.log(failures + ' failure(s), ' + warnings + ' warning(s).');
    process.exit(1);
}
console.log('All checks passed' + (warnings ? ' with ' + warnings + ' warning(s).' : '.'));
process.exit(0);
