# Cross-browser notes

Both builds are Manifest V3. Every file except `manifest.json` is byte-identical
between `chrome/` and `firefox/`, and `tools/check-wiring.js` hashes them to prove
it so a forgotten sync cannot reach a release.

`chrome/` is the source of truth. After changing anything there:

```
powershell -ExecutionPolicy Bypass -File .\tools\sync-firefox.ps1
node tools\check-wiring.js
```

## What differs, and why

### The background script

```jsonc
// chrome/manifest.json
"background": { "service_worker": "background.js" }

// firefox/manifest.json
"background": { "scripts": ["background.js"] }
```

Chrome MV3 requires a service worker. Firefox MV3 accepts an event page, which is
a plain script context rather than a worker. The *same file* satisfies both,
because `background.js` deliberately has no dependency on `shared.js` — a service
worker would need `importScripts()` and an event page would need an extra entry in
`background.scripts`, and neither mechanism exists in the other. `check-wiring.js`
asserts this independence, so the file cannot quietly acquire a dependency.

Practical consequence: the background holds **no state between messages**. It is a
router. Everything durable lives in `chrome.storage.local`, and the assignment
engine lives in the content script where its timers survive.

### `browser_specific_settings`

Firefox only:

```jsonc
"browser_specific_settings": {
  "gecko": {
    "id": "assignflow@arinraj09",
    "strict_min_version": "140.0",
    "data_collection_permissions": { "required": ["none"] }
  }
}
```

The ID is **carried over unchanged from AssignFlow 3.2.0**. That is deliberate:
it makes this an update to the existing add-on rather than a second one, so
users keep the configuration already in their storage. It is also why the version
is `4.0.0` and not `1.0.0` — addons.mozilla.org requires a strictly increasing
version for a given add-on ID, and `1.0.0` would be rejected as older than
`3.2.0`.

`data_collection_permissions: ["none"]` is required by recent AMO submissions and
is accurate: nothing is collected.

`strict_min_version: 140.0` is set by the one genuinely version-sensitive API —
see below.

## What needs no shim

### The `chrome.*` namespace

Firefox implements `chrome.*` under MV3 and returns promises when no callback is
passed, which is the style this codebase uses throughout. So there is no
`browser`/`chrome` alias, no polyfill, and no dual code path.

The reverse is not true: `browser.*` does not exist in Chrome. The 3.x build used
it everywhere, which is why none of that code could have run on Chrome without
this change. `check-wiring.js` fails the build if `browser.*` reappears.

Note the promise style matters. `chrome.storage.local.get(keys, callback)` works
on Chrome but Firefox's implementation returns a promise and ignores a callback in
some cases. Awaiting the promise is the only form that behaves identically, so
every call site awaits.

### Content scripts, popup, options page

Identical declarations, identical behaviour. `options_ui` with
`open_in_tab: true` works the same on both.

## The one version-sensitive API

```js
chrome.scripting.executeScript({ target, world: 'MAIN', func })
```

Used to read the ServiceNow user token (`g_ck`) out of the page's own JavaScript
context. A content script runs in an isolated world and cannot see page globals,
and injecting an inline `<script>` — which the 3.x build did — is blocked by the
instance's Content Security Policy. Executing in the MAIN world through the
scripting API is not subject to page CSP, so it is the only reliable route.

`world: 'MAIN'` support landed in Firefox 128. `strict_min_version` is set to
`140.0`, comfortably above it, matching the floor used across these projects.

Chrome has supported `world: 'MAIN'` since 111.

## Host permissions

Identical in both, and deliberately minimal:

```jsonc
"host_permissions":          ["*://*.service-now.com/*"],
"optional_host_permissions": ["<all_urls>"]
```

Exactly one host is compiled in: ServiceNow's own cloud domain. **No customer or
employer domain ever appears in a manifest.** An on-premise deployment, a vanity
domain or a reverse proxy is added by the user at runtime under
**Settings → Instances**, which calls `chrome.permissions.request()` for that
single host and stores the approved pattern in `snafCustomDomains`.

`background.js` then registers a dynamic content script for whatever was
approved:

```js
await chrome.scripting.registerContentScripts([{
    id:      SNAF_DYNAMIC_SCRIPT_ID,
    matches: patterns,
    js:      SNAF_CONTENT_JS,
    css:     SNAF_CONTENT_CSS,
    runAt:   'document_idle',
    persistAcrossSessions: true
}]);
```

Re-synced on `storage.onChanged`, on `permissions.onAdded` / `onRemoved`, and on
install and startup, so a browser restart or a permission revoked from the
browser's own settings page cannot leave the registration out of step. Stored
patterns are re-verified with `permissions.contains()` rather than trusted, and
the Instances panel shows a *Grant again* action for any that were withdrawn.

Two consequences worth being explicit about:

- **`<all_urls>` is optional and opt-in.** Reviewers treat an opt-in broad
  permission very differently from one requested up front, and the extension is
  fully functional on cloud instances without it.
- **A broad grant is not a claim that every site is ServiceNow.** Under
  `<all_urls>` the content script does load everywhere, so anything that touches
  the network is gated on `resolveTrust()` in `widget.js`: the cloud domain and
  user-named domains are trusted outright, everything else has to satisfy
  `snafLooksLikeServiceNow()` before the keep-alive ping or the engine will run.
  `check-wiring.js` asserts that gate exists.

`check-wiring.js` also fails the build if `host_permissions` or
`content_scripts.matches` is anything other than the single cloud pattern, and
scans every shipped and documented file for company names.

## Packaging

**Chrome / Edge / Brave** — zip the *contents* of `chrome/`, not the folder
itself. `manifest.json` must sit at the archive root.

```powershell
Compress-Archive -Path .\chrome\* -DestinationPath .\sn-assignflow-chrome.zip -Force
```

**Firefox** — build from inside `firefox/`:

```
cd firefox
web-ext build
```

Then either submit `web-ext-artifacts/*.zip` to addons.mozilla.org, or use
`web-ext sign` for a self-distributed signed `.xpi`. Self-distribution still
requires signing; unsigned add-ons only load temporarily via
`about:debugging`.

Run `node tools/check-wiring.js` before either. It exits non-zero on failure, so
it can gate the packaging step directly.

## Things that behave differently at runtime

| Area | Chrome | Firefox |
| --- | --- | --- |
| Background lifetime | Service worker, torn down aggressively when idle | Event page, also unloaded but less eagerly |
| `chrome.storage.local.getBytesInUse` | Implemented | Not implemented; the About section falls back to measuring the serialised size and says so |
| Extension page origin | `chrome-extension://` | `moz-extension://` |
| Unpacked install persistence | Survives restart | Temporary add-ons are removed on restart |

Only the second one required code: the About section checks for the method and
degrades to an approximation rather than showing an error.
