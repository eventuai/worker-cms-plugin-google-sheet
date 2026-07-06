# worker-cms-plugin-google-sheet

Google Sheets sync plugin for Worker CMS. It exports one or more CMS page types
to a spreadsheet, flattens `lect` into columns that follow the CMS edit-form
field naming, then imports edited rows back into draft pages through the CMS
write-back API.

## What it does

- Exports each configured page type to its own sheet tab.
- Uses reversible column names:
  - `name`, `slug`, `weight`, `start`, `end`, `timezone`, `page_id`
  - `@status` for lect attributes/scalars
  - `*mail_list` for lect pointers
  - `.name|mis`, `.name|en`, `.name|zh-hant` for localized fields
  - `.response[0]@status` and `.response[0].message|en` for repeated items
  - `@_blocks[0]@_type`, `@_blocks[0]@title`, and `@_blocks[0].label|mis`
    for editor blocks
- Imports edited rows by `id` and updates the matching CMS draft page.
- Creates page versions and hooks via the normal CMS `/__cms/pages/:id` API.
- Sheet edits are pulled back when the plugin's **Import from Sheet** action is
  run. Google Sheets does not push edits to this Worker automatically.
- Filters exports with advanced-search-style criteria:
  - `search1`, `path1`, `search2`, `path2`, etc.
  - `AND`, `OR`, and `NOT` operators
  - paths such as `status`, `_pointers.mail_list`, or `position[*].title`
  - sort by updated, created, name, weight, or ID

Tag criteria from CMS advanced search are not included yet because the current
CMS plugin page-list API does not return tag IDs for list results.

## Configuration

Set Worker variables/secrets:

```sh
wrangler secret put PLUGIN_SECRET
wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL
wrangler secret put GOOGLE_PRIVATE_KEY
wrangler secret put SHEET_WEBHOOK_SECRET
```

In `wrangler.toml`, set:

```toml
[vars]
CMS_URL = "https://cms.example.com"
SYNC_PAGE_TYPES = "contact,event,guest"
DEFAULT_LANGUAGE = "en"
```

`SYNC_PAGE_TYPES` is important: the manifest declares these as delegated
`readTypes` and `writeTypes`. After registering the plugin in Worker CMS,
approve each page type from the CMS plugin management UI before exporting or
importing.

Set `SYNC_PAGE_TYPES = "*"` to declare *all* page types in the manifest — the
CMS host still enforces its own per-type approvals, so a `*` here just means
"whatever the host has approved is allowed." The wildcard is only used in the
manifest; it is never sent as a literal `page_type`, so when you use `*` you
must choose the concrete page types to sync in the form on each run.

For sync-back, approve both read and write access. If write access is missing,
the import page will show `forbidden_page_type` in the row notes and return a
non-OK status.

## Sheet edit callbacks

Google Sheets does not call plugin Workers directly when a user edits a cell.
To push edits back automatically, add an Apps Script installable edit trigger to
the spreadsheet. The plugin admin page includes a script template that posts to:

```text
https://YOUR_PLUGIN_HOST/__plugin/sheets/callback
```

The callback must include `x-sheet-webhook-secret: SHEET_WEBHOOK_SECRET`. The
plugin then reads the edited spreadsheet through the Sheets API and applies the
same import logic used by **Import from Sheet**.

The plugin admin page includes a **Plugin host** input beside the Apps Script
preview. Typing a host updates the callback URL in the script preview after the
plugin asset `/assets/sheet-sync-admin.js` has been approved from CMS plugin
asset management.

For existing spreadsheets, share the spreadsheet with the service account email.
If the spreadsheet ID is left blank during export, the plugin creates a new
spreadsheet owned by the service account.

## Local callback testing

Google Apps Script cannot call `localhost` or `127.0.0.1`. Test in two steps:

1. Smoke-test the plugin callback locally.
2. Use an HTTPS tunnel for the real Apps Script edit trigger.

Run CMS and the plugin on different local ports:

```sh
# terminal 1, in the CMS repo
npm run dev -- --port 8787

# terminal 2, in this plugin repo
npm run dev -- --port 8788
```

For local plugin variables, use `.dev.vars`:

```dotenv
CMS_URL=http://127.0.0.1:8787
PLUGIN_SECRET=...
SHEET_WEBHOOK_SECRET=local-sheet-secret
GOOGLE_ACCESS_TOKEN=... # convenient for local smoke tests
# or use GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY
```

Smoke-test the callback with `curl`:

```sh
curl -i http://127.0.0.1:8788/__plugin/sheets/callback \
  -X POST \
  -H 'content-type: application/json' \
  -H 'x-sheet-webhook-secret: local-sheet-secret' \
  --data '{"spreadsheetId":"YOUR_SHEET_ID","pageType":"guest","language":"mis"}'
```

For a real Google Sheets edit trigger, expose the plugin port with a tunnel:

```sh
cloudflared tunnel --url http://127.0.0.1:8788
# or: ngrok http 8788
```

Use the generated HTTPS URL in Apps Script:

```js
const CMS_PLUGIN_CALLBACK_URL = 'https://YOUR-TUNNEL.trycloudflare.com/__plugin/sheets/callback';
```

Keep `CMS_URL=http://127.0.0.1:8787` in the plugin `.dev.vars`; the tunnel only
solves inbound traffic from Google to the plugin. The plugin still calls your
local CMS directly from the local dev process.

## Development

```sh
npm install
npm test
npm run typecheck
```
