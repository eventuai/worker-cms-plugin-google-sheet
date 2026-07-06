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
  - `.name|en` for localized fields
  - `.response[0]@status` and `.response[0].message|en` for repeated items
- Imports edited rows by `id` and updates the matching CMS draft page.
- Creates page versions and hooks via the normal CMS `/__cms/pages/:id` API.

## Configuration

Set Worker variables/secrets:

```sh
wrangler secret put PLUGIN_SECRET
wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL
wrangler secret put GOOGLE_PRIVATE_KEY
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

For existing spreadsheets, share the spreadsheet with the service account email.
If the spreadsheet ID is left blank during export, the plugin creates a new
spreadsheet owned by the service account.

## Development

```sh
npm install
npm test
npm run typecheck
```
