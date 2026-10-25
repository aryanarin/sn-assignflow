# Changelog

## 4.1.2

### Changed

- **Session keep-alive now uses the logic from AssignFlow 1.7.1.** A REST call
  on its own does not push a ServiceNow session timeout forward, so each check
  first loads a tiny UI list page — a request of the kind the browser makes when
  you click around — and then verifies the session with a one-row Table API
  read. The interval is 45 seconds by default and is now set in seconds;
  existing minute values are converted automatically on upgrade.
- **A lost session is now handled instead of ignored.** Three failed checks in
  a row pause a running dispatcher, log why, and stop modifying anything.
  Checks keep running, and the next success resumes routing — signing in again
  in that tab is all it takes. Early failures retry after 10 seconds, and
  returning to a background tab triggers a check straight away.
- A 401, 403 or login-page response from the engine also triggers an immediate
  check, rather than waiting for the next timer tick.

### Fixed

- **The Chrome Web Store manifest description is now 117 characters.** The
  previous text was 148 and was rejected by the store's 132-character limit. No
  behaviour change.

## 4.1.1

### Fixed

- **The browser's native sign-in dialog no longer appears on the ServiceNow
  login page.** Keep-alive used to probe the instance as soon as a tab loaded.
  While signed out, ServiceNow answers that probe with an HTTP Basic challenge,
  and the browser turns it into its own username/password dialog on top of the
  login form — looking like the extension wants a second login. Keep-alive and
  the assignment engine now stay off any page that is asking for credentials,
  and resume once the instance is signed in.

## 4.1.0

### Added

- **Light and dark themes across the whole extension.** The theme now applies to
  the toolbar popup and the on-page widget as well as the configuration page.
  It can be switched from the widget header, the popup, the settings page, or
  the configuration rail — whichever is closest. The choice is shared, so all
  four stay in step.
- A saved widget position is nudged back on-screen after the window is resized
  or moved to a smaller display.

### Fixed

- **The widget no longer follows you into new tabs.** Showing it is now scoped
  to the tab it was launched in. Reloading or navigating within that tab keeps
  it open, but a new ServiceNow tab starts with the widget hidden. Previously
  its open state lived in shared storage, so every new tab opened with it.
- The minimised state is scoped the same way, instead of being copied from
  whichever tab touched it last.

### Changed

- The popup and widget now follow the extension theme instead of staying dark,
  and the appearance setting says so rather than describing itself as
  configuration-page-only.

## Unreleased

### Added

- **Report a Bug**, in the navigation rail of the configuration page and in the
  toolbar popup. Opens a mail draft with the extension version and browser
  already filled in, and fields for the ServiceNow shell and instance release.
- **Support panel**, reached from the same two places. Ko-fi for international
  contributions, UPI with a bundled QR code for India, and a link to star the
  repository. The QR is shipped with the extension rather than hotlinked, so the
  panel works offline and reaches no third-party server.

Both mirror the affordances already in SN Commands.

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
