# Store submission notes

Reference answers for the Chrome Web Store and addons.mozilla.org review forms.
Keep these in step with `privacy.html` — a mismatch between the two is the usual
cause of a rejection.

## Single purpose

Automating round-robin assignment of ServiceNow records to a configured rotation
of agents, from within the user's own ServiceNow instance.

## Permission justifications

**`storage`** — Saves the user's assignment groups, their global list of agents,
and their preferences locally. Nothing is stored remotely.

**`tabs`** — Needed to locate the active ServiceNow tab when the user clicks
*Launch Widget*, to open the extension's own configuration page, and to notify
open ServiceNow tabs when the configuration changes. Tab URLs are only ever
tested against the declared ServiceNow host patterns.

**`scripting`** — Two uses. First, reading the ServiceNow user token (`g_ck`)
from the page's own JavaScript context, which the ServiceNow Table API requires
in order to accept a write; a content script runs in an isolated world and cannot
see it, and an inline `<script>` is blocked by the instance's Content Security
Policy. Second, injecting the widget into a ServiceNow tab that was already open
when the extension was installed, so the user does not have to reload the page.

**Host access to `*://*.service-now.com/*` (required)** — The extension only
functions on a ServiceNow instance, and this is the domain ServiceNow serves its
cloud instances from. It is the only host requested at install time.

**`<all_urls>` (optional, opt-in)** — Never requested at install time and never
requested automatically. Many ServiceNow customers run on-premise or on a vanity
domain that the extension cannot know in advance. Settings → Instances lets the
user either name those hosts individually — each one requested on its own through
`chrome.permissions.request()` — or, if they prefer, grant access to all sites in
one step. The extension is fully functional on cloud instances without this, and
even when granted, the widget and the keep-alive ping only act on pages that are
actually ServiceNow instances.

Worth stating plainly in the justification field: the broad permission is
optional and user-triggered. Reviewers weigh that very differently from a broad
permission requested up front.

**Remote code** — None. Every line executed ships inside the package. No
`eval`, no remotely hosted scripts, no CDN assets, no web fonts.

## Data collection disclosure

Declare **no data collection** on both stores. This is accurate:

- No analytics, telemetry, crash reporting or advertising identifiers.
- No data transmitted to the author or any third party; there is no server.
- The only network requests go to the user's own ServiceNow instance, relative to
  the origin of the tab they are already signed in to: reading records via the
  Table API, writing `assigned_to` on a record, resolving a configured agent's
  user ID via `sys_user`, and the keep-alive checks (a one-record UI page plus a
  one-row Table API read).

Personal data (colleagues' names, ServiceNow user IDs, `sys_id`s and optional
email addresses) is entered by the user or fetched from their own instance, is
held only in `chrome.storage.local`, and is deleted by
**Settings → Delete all SN Assignflow data**.

## Firefox specifics

`browser_specific_settings.gecko.data_collection_permissions.required` is set to
`["none"]`, which recent AMO submissions require.

The add-on ID is `sn-assignflow@arinraj09`. Earlier builds used
`assignflow@arinraj09`, which AMO rejected as a duplicate because that ID was
already registered to an add-on submitted during testing. This is therefore a
**new listing** and will not auto-update the test add-on.

Keep this ID unchanged for every future upload so releases continue the same
listing. If the listing is renamed later, note the rename in the version notes so
reviewers do not treat it as a duplicate submission.

## Testing instructions for reviewers

The extension needs a ServiceNow instance to do anything, which a reviewer will
not have. Offer this in the notes field:

> Requires a ServiceNow instance to exercise fully. A free personal developer
> instance from developer.servicenow.com is sufficient.
>
> 1. Click the toolbar icon, then *Open Configuration*.
> 2. Under **Agents**, add any name and user ID, for example `abel.tuter`, which
>    exists in ServiceNow's demo data.
> 3. Under **Assignment Groups**, click *+ Add*. Set the table to `incident` and
>    the filter query to `active=true`. Add the agent created in step 2. Press
>    *Save Changes*.
> 4. Under **Rules**, switch on **Dry run** — nothing will be written to the
>    instance.
> 5. Open the ServiceNow instance in a tab, click the toolbar icon, then
>    *Launch Widget*, then *Start*.
>
> The widget's log will show which records it would assign and to whom. All
> functionality other than the final write is exercised in this mode.

## Screenshot list

All screenshots are 1280×800, 24-bit PNG without transparency, captured from a
fictional demo instance (`helpdesk.acme.test`) with invented tickets and staff.

1. `screenshot-config-light.png` — Assignment Groups: the group editor with the
   agent rotation and query.
2. `screenshot-rules-dark.png` — Rules: dry run, safety switches and per-cycle
   limits.
3. `screenshot-agents-light.png` — Agents: the global directory with resolved
   and pending `sys_id`s.
4. `screenshot-widget-light.png` — The widget running on a ticket list, with the
   live log.
5. `screenshot-widget-dark.png` — The same widget in dark theme.
6. `screenshot-logs-dark.png` — Logs: cycle history across a session.
7. `screenshot-settings-light.png` — Settings: session keep-alive and backups.
8. `screenshot-about-dark.png` — About: engine location, instances and storage
   use.

Use a demo or fictional instance for every screenshot. Do not screenshot a
production instance — real ticket numbers, staff names and `sys_id`s would be
published with the listing.
