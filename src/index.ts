import { CmsApiError, CmsClient, CmsNotConfiguredError } from './cms';
import { GoogleSheetsClient, GoogleSheetsError, sheetTitleFor } from './google';
import { filterAndSortPages, parseCriteria, parseOperator, parseOrder, parseSort } from './search';
import { pagesToSheetValues, sheetValuesToUpdates } from './sheet-mapper';
import type { CmsUser, ImportResult, PluginEnv, SheetCallbackPayload, SyncRequest, SyncResult } from './types';

const PLUGIN_ID = 'google-sheet';
const ADMIN_SCRIPT_ASSET = '/assets/sheet-sync-admin.js';

export default {
  async fetch(request: Request, env: PluginEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === ADMIN_SCRIPT_ASSET) {
      return new Response(ADMIN_SCRIPT, {
        headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    if (path === '/__plugin/manifest') return Response.json(manifest(env));

    if (path === '/__plugin/sheets/callback') {
      return handleSheetCallback(request, env);
    }

    if (path.startsWith('/__plugin/admin')) {
      const forbidden = requirePluginSecret(request, env.PLUGIN_SECRET);
      if (forbidden) return forbidden;
      try {
        return await handleAdmin(request, env, url);
      } catch (error) {
        return errorView(error);
      }
    }

    return new Response('not found', { status: 404 });
  },
};

async function handleSheetCallback(request: Request, env: PluginEnv): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json({ error: 'method_not_allowed' }, { status: 405 });
  }

  const forbidden = requireSheetWebhookSecret(request, env);
  if (forbidden) return forbidden;

  try {
    const payload = await request.json().catch(() => null) as SheetCallbackPayload | null;
    const sync = syncRequestFromCallback(payload, env);
    const result = await importFromSheet(new CmsClient(env), new GoogleSheetsClient(env), sync);
    return Response.json(result, { status: result.ok ? 200 : 409 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: error instanceof GoogleSheetsError ? error.status : 500 });
  }
}

function manifest(env: PluginEnv): Record<string, unknown> {
  const declaredTypes = declaredPageTypes(env);
  return {
    id: PLUGIN_ID,
    name: 'Google Sheet Sync',
    version: '0.1.0',
    nav: [{ label: 'Google Sheets', href: 'sync', roles: ['admin', 'editor'], group: 'settings' }],
    permissions: [
      { value: 'google-sheet:sync', label: 'Google Sheet: export and import CMS pages' },
    ],
    contentTypes: {
      readTypes: declaredTypes,
      writeTypes: declaredTypes,
    },
    assets: [
      { path: ADMIN_SCRIPT_ASSET, label: 'Google Sheet admin callback preview' },
    ],
  };
}

async function handleAdmin(request: Request, env: PluginEnv, url: URL): Promise<Response> {
  const viewResponse = serveAdminView(url);
  if (viewResponse) return viewResponse;

  if (request.method === 'POST') {
    const form = await request.formData();
    const action = String(form.get('action') ?? '');
    const sync = syncRequestFromForm(form, env);
    const user = parseCmsUser(request.headers.get('x-cms-user'));
    const cms = new CmsClient(env, user.id ?? null);
    const sheets = new GoogleSheetsClient(env);

    if (action === 'export') {
      const result = await exportToSheet(cms, sheets, sync);
      return chrome('Google Sheets export', resultView('Export complete', exportSummary(result)));
    }
    if (action === 'import') {
      const result = await importFromSheet(cms, sheets, sync);
      const title = result.ok ? 'Import complete' : 'Import needs attention';
      return chrome('Google Sheets import', resultView(title, importSummary(result)), result.ok ? 200 : 409);
    }
  }

  return clientView('Google Sheets', '/templates/sync.json', syncViewData(env, url.searchParams));
}

async function exportToSheet(cms: CmsClient, sheets: GoogleSheetsClient, sync: SyncRequest): Promise<SyncResult> {
  const titles = sync.pageTypes.map(sheetTitleFor);
  const spreadsheetId = sync.spreadsheetId
    || await sheets.createSpreadsheet(`Worker CMS export ${new Date().toISOString().slice(0, 10)}`, titles);
  if (sync.spreadsheetId) await sheets.ensureSheets(spreadsheetId, titles);

  const results: SyncResult['pageTypes'] = [];
  for (const pageType of sync.pageTypes) {
    const allPages = await cms.listAll(pageType, sync.limit);
    const pages = filterAndSortPages(allPages, sync.criteria, sync.operator, sync.sort, sync.order);
    const values = pagesToSheetValues(pages, sync.language);
    await sheets.writeValues(spreadsheetId, sheetTitleFor(pageType), values);
    results.push({ pageType, total: allPages.length, exported: pages.length, columns: values[0]?.length ?? 0 });
  }

  return { spreadsheetId, spreadsheetUrl: sheets.spreadsheetUrl(spreadsheetId), pageTypes: results };
}

async function importFromSheet(cms: CmsClient, sheets: GoogleSheetsClient, sync: SyncRequest): Promise<ImportResult> {
  if (!sync.spreadsheetId) throw new GoogleSheetsError('Paste a spreadsheet id before importing.', 400);

  const results: ImportResult['pageTypes'] = [];
  for (const pageType of sync.pageTypes) {
    const values = await sheets.readValues(sync.spreadsheetId, sheetTitleFor(pageType));
    const updates = sheetValuesToUpdates(values, pageType, sync.language);
    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (let index = 0; index < updates.length; index += 1) {
      const update = updates[index];
      if (update.id === null || update.error) {
        skipped += 1;
        errors.push(`Row ${index + 2}: ${update.error ?? 'invalid row'}`);
        continue;
      }
      try {
        await cms.update(update.id, { ...update.input, version_action: 'update from google sheet' });
        updated += 1;
      } catch (error) {
        skipped += 1;
        errors.push(`Row ${index + 2}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    results.push({ pageType, rows: updates.length, updated, skipped, errors });
  }

  return {
    spreadsheetId: sync.spreadsheetId,
    spreadsheetUrl: sheets.spreadsheetUrl(sync.spreadsheetId),
    pageTypes: results,
    ok: results.every((result) => result.errors.length === 0),
  };
}

function syncRequestFromForm(form: FormData, env: PluginEnv): SyncRequest {
  const pageTypes = parsePageTypes(String(form.get('page_types') ?? '')) || configuredPageTypes(env);
  if (!pageTypes.length) throw new GoogleSheetsError('Add page types to SYNC_PAGE_TYPES or the form before syncing.', 400);
  const limit = Number(form.get('limit') ?? 500);
  return {
    spreadsheetId: spreadsheetIdFromInput(String(form.get('spreadsheet_id') ?? '')),
    pageTypes,
    language: String(form.get('language') ?? env.DEFAULT_LANGUAGE ?? 'en').trim() || 'en',
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 500) : 500,
    criteria: parseCriteria(form),
    operator: parseOperator(form.get('operator')),
    sort: parseSort(form.get('sort')),
    order: parseOrder(form.get('order')),
  };
}

function syncRequestFromCallback(payload: SheetCallbackPayload | null, env: PluginEnv): SyncRequest {
  if (!payload || typeof payload !== 'object') throw new GoogleSheetsError('Invalid callback payload.', 400);
  const pageTypes = callbackPageTypes(payload) || configuredPageTypes(env);
  if (!pageTypes.length) throw new GoogleSheetsError('Callback payload must include pageType, pageTypes, or sheetName.', 400);
  const spreadsheetId = spreadsheetIdFromInput(String(payload.spreadsheetId ?? ''));
  if (!spreadsheetId) throw new GoogleSheetsError('Callback payload must include spreadsheetId.', 400);
  const limit = Number(payload.limit ?? 500);
  return {
    spreadsheetId,
    pageTypes,
    language: String(payload.language ?? env.DEFAULT_LANGUAGE ?? 'en').trim() || 'en',
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 500) : 500,
    criteria: [],
    operator: 'AND',
    sort: 'updated_at',
    order: 'DESC',
  };
}

function syncViewData(env: PluginEnv, params: URLSearchParams): Record<string, unknown> {
  const pageTypes = params.get('page_types') || configuredPageTypes(env).join(', ');
  const language = params.get('language') || env.DEFAULT_LANGUAGE || 'en';
  const spreadsheetId = params.get('spreadsheet_id') || '';
  const operator = params.get('operator') || 'AND';
  const sort = params.get('sort') || 'updated_at';
  const order = params.get('order') || 'DESC';
  const pluginHost = params.get('plugin_host') || '';
  const ready = !!(env.CMS_URL && env.PLUGIN_SECRET && (env.GOOGLE_ACCESS_TOKEN || (env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_PRIVATE_KEY)));
  return {
    ready,
    callbackReady: !!env.SHEET_WEBHOOK_SECRET,
    spreadsheetId,
    pageTypes,
    language,
    pluginHost,
    webhookSecret: env.SHEET_WEBHOOK_SECRET ?? '',
    appScriptCode: appsScriptTemplate({
      pluginHost: pluginHost || 'https://YOUR_PLUGIN_HOST',
      webhookSecret: env.SHEET_WEBHOOK_SECRET || 'YOUR_SHEET_WEBHOOK_SECRET',
      pageTypes,
      language,
    }),
    operatorOptions: options(['AND', 'OR', 'NOT'], operator),
    sortOptions: options(['updated_at', 'created_at', 'name', 'weight', 'id'], sort, {
      updated_at: 'Updated',
      created_at: 'Created',
      name: 'Name',
      weight: 'Weight',
      id: 'ID',
    }),
    orderOptions: options(['DESC', 'ASC'], order, { DESC: 'Desc', ASC: 'Asc' }),
    criteriaRows: [1, 2, 3, 4, 5].map((index) => ({
      index,
      search: params.get(`search${index}`) || '',
      path: params.get(`path${index}`) || '',
    })),
    adminScriptSrc: `/admin/plugins/${PLUGIN_ID}${ADMIN_SCRIPT_ASSET}`,
  };
}

function options(values: string[], selected: string, labels: Record<string, string> = {}): Array<{ value: string; label: string; selected: boolean }> {
  return values.map((value) => ({ value, label: labels[value] ?? value, selected: value === selected }));
}

function serveAdminView(url: URL): Response | null {
  const prefix = '/__plugin/admin/views';
  if (!url.pathname.startsWith(`${prefix}/`)) return null;
  const viewPath = url.pathname.slice(prefix.length);
  if (viewPath === '/templates/sync.json') {
    return new Response(SYNC_TEMPLATE_JSON, {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  if (viewPath === '/sections/sync.liquid') {
    return new Response(SYNC_SECTION_LIQUID, {
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  return new Response('not found', { status: 404 });
}

const SYNC_TEMPLATE_JSON = JSON.stringify({ sections: { main: { type: 'sync' } }, order: ['main'] });

const SYNC_SECTION_LIQUID = String.raw`<div class="px-4 py-5 sm:px-6 sm:py-8 lg:px-8">
    <div class="flex items-center justify-between gap-4 mb-4">
      <div>
        <h1 class="text-2xl font-bold text-gray-900">Google Sheets</h1>
        <p class="mt-1 text-sm text-gray-500">Export CMS pages to editable sheets and import row changes back into drafts.</p>
      </div>
    </div>

    {% unless ready %}
      <div class="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"><span class="font-semibold">Configuration missing.</span> Set CMS_URL, PLUGIN_SECRET, and Google service-account credentials before syncing.</div>
    {% endunless %}
    {% unless callbackReady %}
      <div class="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"><span class="font-semibold">Callback disabled.</span> Set SHEET_WEBHOOK_SECRET before wiring Google Apps Script edit triggers.</div>
    {% endunless %}

    <form method="post" class="max-w-5xl space-y-5 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <label class="block">
        <span class="block text-sm font-medium text-gray-700 mb-1">Spreadsheet ID or URL</span>
        <input name="spreadsheet_id" value="{{ spreadsheetId | escape }}" placeholder="Leave blank to create a new spreadsheet"
          class="block min-w-0 w-full max-w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
      </label>

      <label class="block">
        <span class="block text-sm font-medium text-gray-700 mb-1">Page types</span>
        <input name="page_types" value="{{ pageTypes | escape }}" placeholder="contact, event, guest" data-sheet-page-types
          class="block min-w-0 w-full max-w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
      </label>

      <div class="grid gap-4 sm:grid-cols-2">
        <label class="block">
          <span class="block text-sm font-medium text-gray-700 mb-1">Language</span>
          <input name="language" value="{{ language | escape }}" data-sheet-language
            class="block min-w-0 w-full max-w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
        </label>
        <label class="block">
          <span class="block text-sm font-medium text-gray-700 mb-1">Page fetch size</span>
          <input type="number" min="1" max="500" name="limit" value="500"
            class="block min-w-0 w-full max-w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
        </label>
      </div>

      <div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_8rem_8rem] md:items-end">
        <label class="block">
          <span class="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-500">Operator</span>
          <select name="operator" class="h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-700 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500">
            {% for option in operatorOptions %}<option value="{{ option.value | escape }}" {% if option.selected %}selected{% endif %}>{{ option.label | escape }}</option>{% endfor %}
          </select>
        </label>
        <label class="block">
          <span class="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-500">Sort</span>
          <select name="sort" class="h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-700 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500">
            {% for option in sortOptions %}<option value="{{ option.value | escape }}" {% if option.selected %}selected{% endif %}>{{ option.label | escape }}</option>{% endfor %}
          </select>
        </label>
        <label class="block">
          <span class="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-500">Order</span>
          <select name="order" class="h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-700 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500">
            {% for option in orderOptions %}<option value="{{ option.value | escape }}" {% if option.selected %}selected{% endif %}>{{ option.label | escape }}</option>{% endfor %}
          </select>
        </label>
      </div>

      <div class="grid gap-3">
        {% for row in criteriaRows %}
          <div class="grid gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3 lg:grid-cols-[3rem_minmax(0,1fr)_minmax(12rem,18rem)] lg:items-start">
            <div class="flex h-10 items-center text-sm font-semibold text-gray-500">#{{ row.index }}</div>
            <label class="block">
              <span class="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-500">Search</span>
              <input type="search" name="search{{ row.index }}" value="{{ row.search | escape }}" placeholder="name email company"
                class="h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-700 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500">
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-500">Path</span>
              <input type="text" name="path{{ row.index }}" value="{{ row.path | escape }}" placeholder="position[*].organization_name"
                class="h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-700 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500">
            </label>
          </div>
        {% endfor %}
      </div>

      <div class="flex flex-wrap items-center gap-3 pt-2">
        <button type="submit" name="action" value="export"
          class="inline-flex h-10 items-center justify-center rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-700">
          Export to Sheet
        </button>
        <button type="submit" name="action" value="import"
          class="inline-flex h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-700 hover:bg-gray-50">
          Import from Sheet
        </button>
      </div>
    </form>

    <div class="mt-5 max-w-5xl rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <div class="mb-3">
        <h2 class="text-lg font-bold text-gray-900">Apps Script callback</h2>
        <p class="mt-1 text-sm text-gray-500">Use an installable edit trigger in the spreadsheet to post edited tabs back to this plugin.</p>
      </div>
      <label class="mb-4 block">
        <span class="block text-sm font-medium text-gray-700 mb-1">Plugin host</span>
        <input value="{{ pluginHost | escape }}" placeholder="https://worker-cms-plugin-google-sheet.example.workers.dev" data-sheet-plugin-host
          class="block min-w-0 w-full max-w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
      </label>
      <p class="mb-3 text-xs text-gray-500">The webhook secret is already inserted from SHEET_WEBHOOK_SECRET. Approve this plugin's admin asset before expecting the preview to update while typing.</p>
      <pre class="overflow-x-auto rounded-lg bg-gray-900 p-4 text-xs text-gray-100"><code data-sheet-apps-script data-webhook-secret="{{ webhookSecret | escape }}">{{ appScriptCode | escape }}</code></pre>
      <script src="{{ adminScriptSrc | escape }}" defer></script>
    </div>
  </div>`;

function resultView(title: string, body: string): string {
  return `<div class="px-4 py-5 sm:px-6 sm:py-8 lg:px-8">
    <div class="flex items-center justify-between gap-4 mb-4">
      <div>
        <h1 class="text-2xl font-bold text-gray-900">${esc(title)}</h1>
      </div>
      <a href="/admin/plugins/${PLUGIN_ID}/sync" class="inline-flex h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-700 hover:bg-gray-50">Back</a>
    </div>
    ${body}
  </div>`;
}

function exportSummary(result: SyncResult): string {
  return `<div class="space-y-4">
    ${notice('Spreadsheet ready', `<a class="font-semibold text-indigo-700 hover:text-indigo-900" href="${esc(result.spreadsheetUrl)}">${esc(result.spreadsheetId)}</a>`, 'green')}
    ${summaryTable(['Page type', 'Fetched', 'Exported', 'Columns'], result.pageTypes.map((item) => [item.pageType, String(item.total), String(item.exported), String(item.columns)]))}
  </div>`;
}

function importSummary(result: ImportResult): string {
  const rows = result.pageTypes.map((item) => [
    item.pageType,
    String(item.rows),
    String(item.updated),
    String(item.skipped),
    item.errors.slice(0, 5).join('; '),
  ]);
  return `<div class="space-y-4">
    ${result.ok
      ? notice('Spreadsheet imported', `<a class="font-semibold text-indigo-700 hover:text-indigo-900" href="${esc(result.spreadsheetUrl)}">${esc(result.spreadsheetId)}</a>`, 'green')
      : notice('Some rows were not imported', `Check the Notes column below. If you see <code>forbidden_page_type</code>, approve write access for this plugin in CMS plugin page-type access.`, 'amber')}
    ${summaryTable(['Page type', 'Rows', 'Updated', 'Skipped', 'Notes'], rows)}
  </div>`;
}

function summaryTable(headers: string[], rows: string[][]): string {
  return `<div class="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
    <table class="w-full min-w-[560px] text-left">
      <thead class="bg-gray-50"><tr>${headers.map((header) => `<th class="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-gray-500">${esc(header)}</th>`).join('')}</tr></thead>
      <tbody class="divide-y divide-gray-100">${rows.map((row) => `<tr>${row.map((cell) => `<td class="px-4 py-3 text-sm text-gray-700">${cell ? esc(cell) : '<span class="text-gray-400">-</span>'}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>
  </div>`;
}

function notice(title: string, message: string, tone: 'green' | 'amber'): string {
  const classes = tone === 'green' ? 'border-green-200 bg-green-50 text-green-800' : 'border-amber-200 bg-amber-50 text-amber-800';
  return `<div class="rounded-xl border ${classes} px-4 py-3 text-sm"><span class="font-semibold">${esc(title)}.</span> ${message}</div>`;
}

function criterionRow(index: number, params: URLSearchParams): string {
  const search = params.get(`search${index}`) || '';
  const path = params.get(`path${index}`) || '';
  return `<div class="grid gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3 lg:grid-cols-[3rem_minmax(0,1fr)_minmax(12rem,18rem)] lg:items-start">
    <div class="flex h-10 items-center text-sm font-semibold text-gray-500">#${index}</div>
    <label class="block">
      <span class="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-500">Search</span>
      <input type="search" name="search${index}" value="${esc(search)}" placeholder="name email company"
        class="h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-700 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500">
    </label>
    <label class="block">
      <span class="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-500">Path</span>
      <input type="text" name="path${index}" value="${esc(path)}" placeholder="position[*].organization_name"
        class="h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-700 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500">
    </label>
  </div>`;
}

function option(value: string, label: string, selected: string): string {
  return `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`;
}

function errorView(error: unknown): Response {
  const message = error instanceof CmsNotConfiguredError || error instanceof CmsApiError || error instanceof GoogleSheetsError
    ? error.message
    : 'Unexpected plugin error.';
  const status = error instanceof GoogleSheetsError ? error.status : 500;
  return chrome('Google Sheets error', resultView('Sync failed', notice('Error', esc(message), 'amber')), status);
}

function chrome(title: string, body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'x-cms-chrome': '1',
      'x-cms-title': encodeURIComponent(title),
      'cache-control': 'no-store',
    },
  });
}

function clientView(title: string, viewPath: string, data: Record<string, unknown>): Response {
  return Response.json(data, {
    headers: {
      'x-cms-chrome': '1',
      'x-cms-client-view': '1',
      'x-cms-view-path': viewPath,
      'x-cms-title': encodeURIComponent(title),
      'cache-control': 'no-store',
    },
  });
}

function requirePluginSecret(request: Request, secret: string | undefined): Response | null {
  if (!secret) return new Response('server misconfigured', { status: 500, headers: { 'cache-control': 'no-store' } });
  if (request.headers.get('x-plugin-secret') !== secret) return new Response('forbidden', { status: 403, headers: { 'cache-control': 'no-store' } });
  return null;
}

function requireSheetWebhookSecret(request: Request, env: PluginEnv): Response | null {
  if (!env.SHEET_WEBHOOK_SECRET) {
    return Response.json({ error: 'webhook_not_configured' }, { status: 500 });
  }
  const actual = request.headers.get('x-sheet-webhook-secret') ?? new URL(request.url).searchParams.get('secret');
  if (actual !== env.SHEET_WEBHOOK_SECRET) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  return null;
}

function parseCmsUser(header: string | null): CmsUser {
  if (!header) return {};
  try {
    const parsed = JSON.parse(header) as CmsUser;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// Page types declared to the CMS host for delegated read/write. Supports the
// "*" wildcard, which asks the host to allow every page type it has approved
// for this plugin.
function declaredPageTypes(env: PluginEnv): string[] {
  return parsePageTypes(env.SYNC_PAGE_TYPES ?? '') ?? [];
}

// Concrete page types used to pre-fill the form and as the sync fallback. "*"
// is only meaningful in the manifest, so it is stripped here and never sent as
// an actual page_type to the CMS.
function configuredPageTypes(env: PluginEnv): string[] {
  return declaredPageTypes(env).filter((type) => type !== '*');
}

function callbackPageTypes(payload: SheetCallbackPayload): string[] | null {
  if (Array.isArray(payload.pageTypes)) {
    const types = payload.pageTypes.map((value) => String(value).trim()).filter(Boolean);
    return types.length ? [...new Set(types)] : null;
  }
  if (typeof payload.pageTypes === 'string') return parsePageTypes(payload.pageTypes);
  if (typeof payload.pageType === 'string' && payload.pageType.trim()) return [payload.pageType.trim()];
  if (typeof payload.sheetName === 'string' && payload.sheetName.trim()) return [payload.sheetName.trim()];
  return null;
}

function parsePageTypes(value: string): string[] | null {
  const types = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  return types.length ? [...new Set(types)] : null;
}

function spreadsheetIdFromInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const match = trimmed.match(/\/spreadsheets\/d\/([^/]+)/);
  return match ? match[1] : trimmed;
}

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string));
}

function appsScriptTemplate(opts: { pluginHost: string; webhookSecret: string; pageTypes: string; language: string }): string {
  const host = opts.pluginHost.replace(/\/+$/, '') || 'https://YOUR_PLUGIN_HOST';
  return `const CMS_PLUGIN_CALLBACK_URL = '${jsString(`${host}/__plugin/sheets/callback`)}';
const CMS_PLUGIN_WEBHOOK_SECRET = '${jsString(opts.webhookSecret)}';
const CMS_PLUGIN_PAGE_TYPES = '${jsString(opts.pageTypes)}';
const CMS_PLUGIN_LANGUAGE = '${jsString(opts.language)}';

function onCmsSheetEdit(e) {
  const spreadsheet = SpreadsheetApp.getActive();
  const sheetName = e && e.range ? e.range.getSheet().getName() : '';
  UrlFetchApp.fetch(CMS_PLUGIN_CALLBACK_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-sheet-webhook-secret': CMS_PLUGIN_WEBHOOK_SECRET },
    payload: JSON.stringify({
      spreadsheetId: spreadsheet.getId(),
      pageTypes: CMS_PLUGIN_PAGE_TYPES ? CMS_PLUGIN_PAGE_TYPES.split(',').map(function (value) { return value.trim(); }).filter(Boolean) : undefined,
      sheetName: sheetName,
      language: CMS_PLUGIN_LANGUAGE
    }),
    muteHttpExceptions: true
  });
}`;
}

function jsString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

const ADMIN_SCRIPT = String.raw`(function () {
  function quote(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  function buildCode(host, secret, pageTypes, language) {
    var normalizedHost = String(host || '').trim().replace(/\/+$/, '') || 'https://YOUR_PLUGIN_HOST';
    return "const CMS_PLUGIN_CALLBACK_URL = '" + quote(normalizedHost + '/__plugin/sheets/callback') + "';\n"
      + "const CMS_PLUGIN_WEBHOOK_SECRET = '" + quote(secret || 'YOUR_SHEET_WEBHOOK_SECRET') + "';\n"
      + "const CMS_PLUGIN_PAGE_TYPES = '" + quote(pageTypes || '') + "';\n"
      + "const CMS_PLUGIN_LANGUAGE = '" + quote(language || 'mis') + "';\n\n"
      + "function onCmsSheetEdit(e) {\n"
      + "  const spreadsheet = SpreadsheetApp.getActive();\n"
      + "  const sheetName = e && e.range ? e.range.getSheet().getName() : '';\n"
      + "  UrlFetchApp.fetch(CMS_PLUGIN_CALLBACK_URL, {\n"
      + "    method: 'post',\n"
      + "    contentType: 'application/json',\n"
      + "    headers: { 'x-sheet-webhook-secret': CMS_PLUGIN_WEBHOOK_SECRET },\n"
      + "    payload: JSON.stringify({\n"
      + "      spreadsheetId: spreadsheet.getId(),\n"
      + "      pageTypes: CMS_PLUGIN_PAGE_TYPES ? CMS_PLUGIN_PAGE_TYPES.split(',').map(function (value) { return value.trim(); }).filter(Boolean) : undefined,\n"
      + "      sheetName: sheetName,\n"
      + "      language: CMS_PLUGIN_LANGUAGE\n"
      + "    }),\n"
      + "    muteHttpExceptions: true\n"
      + "  });\n"
      + "}";
  }

  function bind(root) {
    var code = root.querySelector('[data-sheet-apps-script]');
    var host = root.querySelector('[data-sheet-plugin-host]');
    var pageTypes = root.querySelector('[data-sheet-page-types]');
    var language = root.querySelector('[data-sheet-language]');
    if (!code || !host) return;

    function update() {
      code.textContent = buildCode(
        host.value,
        code.getAttribute('data-webhook-secret') || '',
        pageTypes ? pageTypes.value : '',
        language ? language.value : 'mis'
      );
    }

    host.addEventListener('input', update);
    if (pageTypes) pageTypes.addEventListener('input', update);
    if (language) language.addEventListener('input', update);
    update();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { bind(document); });
  } else {
    bind(document);
  }
})();`;
