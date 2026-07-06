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

The callback authenticates with the `x-sheet-webhook-secret` header (a
`?secret=` query parameter is not accepted — it would leak into access logs).
The payload is a notification only: `spreadsheetId`, the tab name, and
`rowNumbers` — the 1-based rows the edit touched. The plugin re-reads **only
those rows** from the spreadsheet through the Sheets API (a one-cell edit
re-reads one row, not the whole sheet) and applies the same verified import
logic used by **Import from Sheet**. Row *content* is never taken from the
payload — `rowNumbers` only points at rows, so a caller holding the token can
at most trigger a re-import of rows that are already in the sheet, all
`_hash`-verified. A callback must include `rowNumbers`; at most `200` rows are
processed per callback.

### Callback tokens (how the secret is shared with Apps Script)

Anything pasted into a container-bound Apps Script is readable by every editor
of that spreadsheet, so the generated script never contains the raw
`SHEET_WEBHOOK_SECRET`. Instead the plugin derives a **per-spreadsheet
callback token**:

```text
token = base64url( HMAC-SHA256( SHEET_WEBHOOK_SECRET, "callback:" + spreadsheetId ) )
```

The sync page fills the token into the script preview as soon as a spreadsheet
ID is set, and the export-complete page always includes it — so editors can
set up their own triggers without an admin handing them any global credential.
A leaked token only authorizes callbacks for that one spreadsheet (which the
holder could already edit), and even then only triggers a re-import of the
sheet's own `_hash`-verified content. Rotating `SHEET_WEBHOOK_SECRET`
invalidates every issued token.

## Row integrity (`_hash`)

Every exported row carries a trailing `_hash` column: an HMAC-SHA256 token
(keyed on `PLUGIN_SECRET`) over the page's exported state plus the spreadsheet
id. On import, each row is verified before it is written:

1. The current page is fetched from the CMS and its token recomputed.
2. If the tokens differ, the row is skipped and reported as a conflict — the
   page changed in the CMS after the export (or the token was forged/copied
   from another spreadsheet). Re-export to pick up the current state.
3. If they match, the update is applied and the `_hash` cell is refreshed with
   a token for the new state, so the sheet stays importable.

Rows without a `_hash` are skipped (sheets exported before this feature must be
re-exported once). The token also pins each row to its page id and spreadsheet:
retyping the `id` cell, editing the `page_type` cell (the tab name decides the
type), copying rows into another spreadsheet, or replaying an old callback all
fail verification instead of overwriting CMS content. Rotating `PLUGIN_SECRET`
invalidates all outstanding sheet tokens.

Do not edit or delete the `_hash` column in the spreadsheet.

The plugin admin page includes a **Plugin host** input beside the Apps Script
preview. Typing a host updates the callback URL in the script preview after the
plugin asset `/assets/sheet-sync-admin.js` has been approved from CMS plugin
asset management.

Create the spreadsheet yourself (e.g. via [sheets.new](https://sheets.new)),
share it with the service account email, then paste its URL into the
**Spreadsheet ID or URL** field. The field is required for export and import —
the plugin no longer auto-creates a spreadsheet, since one owned by the
service account isn't accessible to the CMS user without extra sharing steps.

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
