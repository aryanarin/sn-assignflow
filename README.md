# SN Assignflow

Round-robin auto-assignment for ServiceNow. Point it at a filtered list, give it
a rotation of agents, and it distributes incoming work evenly on a timer — from a
widget that runs on the instance itself.

Runs on Chrome, Edge, Brave and Firefox. Manifest V3 on both, no remote code,
no server.

---

## Features

- **Round robin over your own filter.** Any table, any `sysparm_query`. Paste a
  filtered ServiceNow list URL and the query and table are read out of it,
  including from multiply-encoded `/now/nav/` URLs.
- **Configure agents by user ID.** You don't need to hunt down a `sys_id`. Type
  a ServiceNow user ID and it is resolved once, cached on the agent and added to
  your global user list. A `sys_id` still works if you have one.
- **A global user list.** Declare people once under **Agents**, and every group
  offers them as suggestions. Suggestions are optional — a one-off agent who
  isn't in the list still works.
- **Import and export, selectively.** Groups and the user list each have
  *import*, *export selected* and *export all*. The user list also reads and
  writes CSV. There's a full backup of everything under Settings.
- **Session keep-alive, built in.** Pings a small endpoint on your instance so
  you don't get logged out mid-ticket, and it is forced on whenever the engine
  is running so a long unattended run can't be cut short by a logout.
- **Dry run.** Work out and log every assignment without writing anything. The
  honest way to check a new filter before trusting it.
- **Safety limits.** Cap assignments per cycle and per agent per cycle, and keep
  a broad filter from reassigning work that already has an owner.
- **A log you can read later.** Recent activity is kept across tabs and
  instances, filterable by level, exportable as text.
- **Works on your instance, whatever it's called.** ServiceNow's cloud domain is
  built in; on-premise and vanity domains are added by you at runtime. No
  company domain is compiled into the extension.

## Instances

Out of the box the extension only asks for access to `*.service-now.com`, which
is where ServiceNow serves its cloud instances.

If yours is somewhere else — on-premise, a vanity domain, behind a proxy — open
**Settings → Instances** and either:

- **add the hostname**, and your browser will ask for permission for that one
  host; or
- **switch on "Enable on all websites"** if you'd rather not enumerate them, or
  your instance hostname changes.

Either way the permission is requested at that moment, granted only if you
approve, and revocable whenever you like. Newly granted hosts start working
immediately — the content script is registered dynamically, so there's no need
for a new build or a browser restart. Reload any tab that was already open on
that host.

Allowing all sites is a convenience, not a declaration that every site is
ServiceNow. Under a broad grant the extension only acts once a page is confirmed
to be an instance: domains you named are trusted on your word, anything else has
to carry ServiceNow's own markers. On an unrelated site it does nothing and
sends no requests — in particular, the keep-alive ping never fires there.

## Installation

### Chrome / Edge / Brave

1. Download or clone this repository.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Turn on **Developer mode**, top-right.
4. Click **Load unpacked** and select the `chrome/` folder.

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick any file inside `firefox/`, for
   example `firefox/manifest.json`.
3. Temporary add-ons are removed when Firefox restarts. For a permanent install,
   run `web-ext build` inside `firefox/` and either self-distribute the signed
   `.xpi` or submit it to [addons.mozilla.org](https://addons.mozilla.org).

### Upgrading from AssignFlow 3.x

The Firefox add-on ID is unchanged, so this installs as an update rather than a
second add-on, and **your existing groups, agents and round-robin positions are
kept** — the storage keys from 3.x are read as they are. Nothing to export first.

Two things do change: the widget starts hidden until you launch it (as before)
but now remembers where you put it, and the group editor requires an explicit
**Save Changes** instead of writing on every keystroke.

## Usage

1. Click the toolbar icon → **Open Configuration**.
2. Under **Agents**, add the people you dispatch to. A name and a ServiceNow
   user ID is enough. With a ServiceNow tab open, **Resolve sys_ids** fills in
   the rest.
3. Under **Assignment Groups**, click **+ Add**. Name the group, then paste a
   filtered ServiceNow list URL into the converter to fill in the query and
   table. Add agents to the rotation — start typing and your global list is
   offered.
4. Press **Save Changes**.
5. Under **Rules**, switch on **Dry run**.
6. Open your instance, click the toolbar icon → **Launch Widget**, and press
   **Start**. Read the log and confirm it selects what you expect.
7. Turn dry run off and let it run.

### The widget

Launched per tab from the toolbar popup, and it stays where you drag it.

| Control | What it does |
| --- | --- |
| **Start / Pause / Stop** | Runs a cycle now, then every interval. Pause holds the countdown; Stop clears it. |
| **Scope** | Restrict a run to one group instead of all active ones. |
| **Every** | Cycle interval, from 30 seconds to 30 minutes. |
| **Minimise** (`—`) | Collapses to a small pill. Click the pill to expand it again. |
| **Close** (`✕`) | Hides the widget. Your configuration is untouched. |

The panel header is a drag handle and nothing else — clicking it does not
collapse the panel. Minimising is always a deliberate press of the minimise
button.

## Configuring agents by user ID

An agent row carries a display name and one identity field, which accepts
either form:

| What you enter | What happens |
| --- | --- |
| A 32-character `sys_id` | Used directly. No lookup. |
| A ServiceNow user ID | Resolved through `sys_user` on first run, then cached on the agent row and added to your global list. Later runs cost nothing. |
| Nothing, just a name | Matched against your global list. If it isn't there, it's tried as a user ID, then as a display name. |

Resolution is exact by design. If a term matches more than one user the row is
skipped and the log says so, rather than guessing which colleague you meant.

Turning off **Resolve user IDs automatically** under Rules makes an explicit
`sys_id` mandatory on every agent.

### Import formats for the user list

JSON, either a bare array or an export from this extension:

```json
{ "users": [
  { "name": "Aryan Raj", "user_name": "aryan.raj", "sys_id": "1474e765…" }
] }
```

Or CSV with a header row. Column names are matched loosely — `user_id`,
`user_name`, `username` and `login` all mean the same thing, as do `name`,
`full_name` and `display_name`:

```csv
name,user_id,sys_id
Aryan Raj,aryan.raj,1474e7651b69c010f826bb31dd4d1a2b
Shusara K,shusara,
```

A headerless CSV is read positionally as `name, user_id, sys_id`. Quoted fields
containing commas are handled, so `"Doe, Jane"` survives a round trip.

Imports **merge** on identity rather than position: re-importing a list fills in
missing `sys_id`s on people you already have instead of duplicating them.

## Rules

Global, applied to every group, and picked up on the next cycle without
restarting a running engine.

| Rule | Default | Effect |
| --- | --- | --- |
| Dry run | off | Logs every assignment, writes nothing, advances nothing. |
| Only assign unassigned tickets | on | Appends `^assigned_toISEMPTY` to any query that doesn't already mention `assigned_to`. |
| Resolve user IDs automatically | on | Looks up missing `sys_id`s and remembers them. |
| Maximum assignments per cycle | 0 (uncapped) | Counted across all groups in the cycle. |
| Maximum per agent, per cycle | 0 (uncapped) | Stops one cycle dumping a backlog on whoever is next. |

## Session keep-alive

Replaces the userscript this was previously done with. Settings → **Session
keep-alive**, on by default, every 2 minutes.

It tries `/api/now/session`, then `/now/nav/header`, then `/stats.do`, rotating
to the next one on a non-OK response because instances differ in what they
expose. It also pings once when you return to a tab that has been in the
background, which is exactly where sessions quietly expire.

**Always keep alive while the engine runs** overrides the main toggle whenever a
dispatcher is running or paused. That is the point of it: an unattended run must
not be ended by a logout.

The request goes to *the instance in that tab*, relative to its own origin. It
sends only the session cookie your browser already sends, reads nothing from the
page, and keeps nothing from the response.

## Privacy

There is no server behind this extension and nothing is sent anywhere except
your own ServiceNow instance. Network activity is exactly three things: reading
tickets from the Table API, writing `assigned_to` back, and the keep-alive ping.
Everything you configure stays in `chrome.storage.local` on your machine. Full
detail in [privacy.html](privacy.html).

Exported files contain real user `sys_id`s and names. `.gitignore` excludes them
by default — worth keeping that way.

## Project structure

```
assignflow/
├── chrome/                # Chrome/Edge/Brave build (MV3, service worker)
│   ├── manifest.json
│   ├── shared.js          # Storage keys, settings, user-directory helpers, query parsing
│   ├── background.js      # Message router; reads g_ck from the page's MAIN world
│   ├── widget.js          # Injected dispatcher: the engine, keep-alive, the log
│   ├── widget.css
│   ├── popup.html/.css/.js
│   ├── config.html/.css/.js
│   ├── theme.css          # Purple Majesty palette + shared UI primitives
│   └── icons/
├── firefox/               # Firefox build (MV3, event-page background)
│   └── ...                # Identical to chrome/, only manifest.json differs
├── tools/
│   ├── make-icons.ps1     # Regenerates the icon set from the brand colour
│   ├── sync-firefox.ps1   # Copies the shared files chrome/ -> firefox/
│   └── check-wiring.js    # Build checks; no dependencies
└── docs/
    └── CROSS_BROWSER.md   # What differs between the two manifests, and why
```

`chrome/` is the source of truth. Every file except `manifest.json` is
byte-identical in both builds, so after changing anything there:

```
powershell -ExecutionPolicy Bypass -File .\tools\sync-firefox.ps1
node tools\check-wiring.js
```

`check-wiring.js` runs on a bare Node install. It validates both manifests,
confirms every file the manifests and HTML pages reference exists, parses all
the JavaScript, checks every `getElementById` has matching markup — including
`widget.js` against the template it builds itself — verifies every message that
gets sent has a listener, checks that no stylesheet rule targets an element that
no longer exists, and hashes the shared files in both folders so a forgotten sync
can't reach a release.

It also asserts a set of behaviours that would be easy to regress:

- **No company name** appears in any shipped or documented file.
- `host_permissions` and `content_scripts.matches` are *only* the ServiceNow
  cloud pattern, and `<all_urls>` is offered as opt-in rather than required.
- Keep-alive endpoints stay instance-relative, and the ping is gated on the page
  being a confirmed instance.
- The panel header has no click-to-collapse handler, and minimise and close are
  separate controls.
- Dry run short-circuits before the write.
- No file uses the `browser.*` namespace.
- The storage keys inherited from 3.x are unchanged.
- `background.js` loads `shared.js` behind an `importScripts` guard *and* the
  Firefox manifest lists `shared.js` first — both halves are needed, and missing
  either breaks exactly one browser.

See [docs/CROSS_BROWSER.md](docs/CROSS_BROWSER.md) for what differs between the
two manifests and why, including the dynamic content-script registration used
for custom instances.

## Why the engine runs in the tab

A Manifest V3 service worker is torn down when idle, which would kill the cycle
timer mid-run. A content script's timers live exactly as long as the tab does.
It also means every request is same-origin to the instance in front of you and
rides the session already open there, with no cross-origin credentials anywhere.

The one thing a content script cannot do is read `g_ck`: it runs in an isolated
world, and injecting an inline `<script>` is blocked by the instance's CSP. So
the token is read in the page's MAIN world through `chrome.scripting`, which CSP
does not apply to.

## License

MIT — see [LICENSE](LICENSE).
