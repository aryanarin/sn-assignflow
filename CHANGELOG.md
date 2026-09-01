# Changelog

## 4.0.0

Renamed to **SN Assignflow**, rebuilt for Chrome and Firefox, and re-themed.

Existing configurations are read as they are. The Firefox add-on ID is unchanged,
so this arrives as an update and your groups, agents and round-robin positions
survive it.

### Added

- **Chrome, Edge and Brave support.** Manifest V3 on both browsers, with every
  file except `manifest.json` shared byte-for-byte between the two builds.
- **Agents can be configured by ServiceNow user ID** instead of `sys_id`. The ID
  is resolved through `sys_user` on first run, then cached on the agent row so
  later runs cost nothing. Ambiguous matches are reported rather than guessed.
- **A global user list** (Agents section). Declare people once; every group
  offers them as ranked suggestions while you type. Picking one is optional —
  free text still works for a one-off agent.
- **Import / export selected / export all**, for both the user list and the
  assignment groups. The user list also reads and writes CSV, with loose header
  matching and quote-aware parsing. Imports merge on identity, so re-importing
  fills in missing `sys_id`s instead of creating duplicates.
- **Exporting groups carries the agents they reference**, so a file lands
  somewhere else complete rather than half-resolved.
- **Session keep-alive is now built in**, replacing the separate userscript. On
  by default, every 2 minutes, with endpoint rotation and a ping when you return
  to a backgrounded tab. Forced on whenever the engine is running or paused.
- **Rules section** with real safety controls: dry run, an unassigned-only guard,
  a per-cycle cap, and a per-agent-per-cycle cap.
- **Dry run**, which logs every assignment it would make and writes nothing —
  no records touched, no counters moved, no round-robin position advanced.
- **Logs section**: recent activity kept across tabs and instances, filterable
  by text and level, exportable as text.
- **Full backup** export and import under Settings, plus a delete-everything
  reset.
- The widget now **remembers its position and open state**, so a ServiceNow
  navigation no longer throws it away.
- A **Save Changes** button with unsaved-change tracking, `Ctrl+S`, and a warning
  if you navigate away mid-edit.

### Fixed

- **The widget no longer collapses when you click its header.** Both the pill and
  the panel header used to call the same toggle, so any click near the title bar
  minimised the panel and it felt like it was toggling at random. The header is
  now a drag handle only, with an explicit minimise button and a separate close
  button. Clicking the minimised pill expands it, as before.
- **The user token is read reliably.** The old build injected an inline
  `<script>` to reach `g_ck`, which a ServiceNow instance's Content Security
  Policy blocks. It is now read from the page's MAIN world through
  `chrome.scripting`, which CSP does not apply to.
- **A lapsed session is reported as one.** Requests that came back as the login
  page previously surfaced as a JSON parse error; they now say the session
  expired. A rotated token is dropped and re-read instead of failing every
  remaining ticket.
- **A failing group no longer stalls a cycle.** Unresolvable agents are reported
  once and skipped, and a session-level failure halts that group instead of
  retrying against every remaining ticket.
- **Launching the widget works on tabs that predate the install.** The content
  script is injected on demand instead of asking you to reload the page.
- Dragging can no longer put the widget off-screen; the position is clamped to
  the viewport.
- Deleting a group now also removes its orphaned round-robin cursor.
- The configuration page no longer steals focus mid-typing when it saves.

### Changed

- **Purple Majesty theme** across the popup, configuration page and widget:
  `#7C3AED` brand, `#1E1B4B` ink navigation rail, `#EDE9FE` / `#F5F3FF` tints.
  Emoji icons are gone in favour of inline SVG, hover effects are colour and
  border only, and the pulsing status dot is now static.
- The configuration page is organised behind a navigation rail — Assignment
  Groups, Rules, Agents, Logs, Settings, About — rather than one long page.
- Group edits are staged and committed on **Save Changes**. Previously every
  keystroke was written straight to storage and pushed to any running engine.
- The engine talks to the Table API through `fetch` rather than `XMLHttpRequest`,
  and reports the instance's own error message when a write is rejected.
- User lookups are batched into a single `user_nameIN` query where possible.
- Manifest V2 → V3. The `browser.*` namespace is gone; both builds use `chrome.*`
  with promises, which Firefox implements under MV3.
- Host permissions moved out of `permissions` into `host_permissions`.
- **No company domain is compiled into the extension any more.** 3.x hardcoded a
  specific employer's on-premise hosts in the manifest. The only host requested
  at install time is now ServiceNow's own cloud domain; every other instance is
  added by the user under **Settings → Instances**, which requests that single
  host permission at the moment they add it and registers a content script for it
  dynamically. `<all_urls>` is available as an opt-in for anyone who would rather
  not enumerate hosts, and is never requested automatically.
- Anything that touches the network is gated on the page actually being a
  ServiceNow instance, so a broad grant does not turn the keep-alive ping loose
  on unrelated sites.
- Log history is capped at 500 entries and written in batches rather than one
  storage write per line.

### Notes for packaging

`tools/check-wiring.js` gates a release and needs no `npm install`. Run
`tools/sync-firefox.ps1` after any change under `chrome/`, or the drift check
will fail.

---

## 3.2.0 and earlier

Firefox-only, Manifest V2, published as **AssignFlow**. Round-robin assignment
configured entirely by `sys_id`, with a dark blue theme and a separate
Tampermonkey userscript for session keep-alive.
