import { CmsApiError, CmsClient, CmsNotConfiguredError } from './cms';
import { GoogleSheetsClient, GoogleSheetsError, sheetTitleFor } from './google';
import { SIGNATURE_COLUMN, callbackToken, hashIncludesSignature, pageHash, pageSignature, secureEquals } from './integrity';
import { filterAndSortPages, parseCriteria, parseOperator, parseOrder, parseSort } from './search';
import { pagesToSheetValues, sheetColumnsForPages, sheetRowsToUpdates, sheetValuesToUpdates } from './sheet-mapper';
import type { RowUpdate } from './sheet-mapper';
import type { CmsUser, ImportResult, PluginEnv, SheetCallbackPayload, SyncPreviewResult, SyncRequest, SyncResult } from './types';

const PLUGIN_ID = 'google-sheet';
const ADMIN_SCRIPT_ASSET = '/assets/sheet-sync-admin.js';
// Upper bound on rows re-read per edit callback, so an unusually large edit
// range cannot fan out into an unbounded number of CMS subrequests.
const MAX_CALLBACK_ROWS = 200;

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
  if (!env.SHEET_WEBHOOK_SECRET) {
    return Response.json({ error: 'webhook_not_configured' }, { status: 500 });
  }

  try {
    // The callback credential is scoped to the spreadsheet in the payload, so
    // the payload must be parsed before the credential can be verified.
    const payload = await request.json().catch(() => null) as SheetCallbackPayload | null;
    const sync = syncRequestFromCallback(payload, env);
    const forbidden = await requireCallbackAuth(request, env.SHEET_WEBHOOK_SECRET, sync.spreadsheetId);
    if (forbidden) return forbidden;
    const result = await importFromSheet(new CmsClient(env), new GoogleSheetsClient(env), sync, env);
    return Response.json(result, { status: result.ok ? 200 : 409 });
  } catch (error) {
    // Only surface messages from our own typed errors; anything else could
    // leak internals to whoever holds the webhook secret.
    if (error instanceof GoogleSheetsError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof CmsApiError || error instanceof CmsNotConfiguredError) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    return Response.json({ error: 'unexpected_error' }, { status: 500 });
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
      { path: ADMIN_SCRIPT_ASSET, label: 'Google Sheet admin helpers' },
    ],
  };
}

async function handleAdmin(request: Request, env: PluginEnv, url: URL): Promise<Response> {
  const viewResponse = serveAdminView(url);
  if (viewResponse) return viewResponse;

  const user = parseCmsUser(request.headers.get('x-cms-user'));

  if (request.method === 'POST') {
    const form = await request.formData();
    const action = String(form.get('action') ?? '');
    const sync = syncRequestFromForm(form, env);
    const cms = new CmsClient(env, user.id ?? null);
    const sheets = new GoogleSheetsClient(env);

    if (action === 'preview' || action.startsWith('select_all:') || action.startsWith('clear_all:')) {
      const result = await previewExport(cms, sync);
      const previewSync = applyColumnToggle(sync, result, action);
      return chrome('Google Sheets preview', resultView('Preview export columns', previewView(previewSync, result)));
    }
    if (action === 'export') {
      const result = await exportToSheet(cms, sheets, sync, env);
      return chrome('Google Sheets export', resultView('Export complete', await exportSummary(result, sync, env)));
    }
    if (action === 'import') {
      const result = await importFromSheet(cms, sheets, sync, env);
      const title = result.ok ? 'Import complete' : 'Import needs attention';
      return chrome('Google Sheets import', resultView(title, importSummary(result)), result.ok ? 200 : 409);
    }
  }

  return clientView('Google Sheets', '/templates/sync.json', await syncViewData(env, url.searchParams));
}

async function previewExport(cms: CmsClient, sync: SyncRequest): Promise<SyncPreviewResult> {
  const results: SyncPreviewResult['pageTypes'] = [];
  for (const pageType of sync.pageTypes) {
    const allPages = await cms.listAll(pageType, sync.limit);
    const pages = filterAndSortPages(allPages, sync.criteria, sync.operator, sync.sort, sync.order);
    results.push({
      pageType,
      total: allPages.length,
      exported: pages.length,
      columns: sheetColumnsForPages(pages, sync.language),
    });
  }
  return { pageTypes: results };
}

// Handles the "Select all" / "Clear all" buttons on the preview page: each is
// a submit button named `action` with value `select_all:{pageType}` or
// `clear_all:{pageType}`, re-rendering the same preview with that page type's
// column selection forced to all-columns or id-only.
function applyColumnToggle(sync: SyncRequest, result: SyncPreviewResult, action: string): SyncRequest {
  const colonIndex = action.indexOf(':');
  if (colonIndex === -1) return sync;
  const mode = action.slice(0, colonIndex);
  const targetType = action.slice(colonIndex + 1);
  if (mode !== 'select_all' && mode !== 'clear_all') return sync;
  const item = result.pageTypes.find((entry) => entry.pageType === targetType);
  if (!item) return sync;
  return {
    ...sync,
    selectedColumns: {
      ...sync.selectedColumns,
      [targetType]: mode === 'select_all' ? item.columns : ['id'],
    },
  };
}

async function exportToSheet(cms: CmsClient, sheets: GoogleSheetsClient, sync: SyncRequest, env: PluginEnv): Promise<SyncResult> {
  if (!sync.spreadsheetId) throw new GoogleSheetsError('Create a spreadsheet, share it with the service account, then paste its URL before exporting.', 400);
  const key = integrityKey(env);
  const spreadsheetId = sync.spreadsheetId;
  await sheets.ensureSheets(spreadsheetId, sync.pageTypes.map(sheetTitleFor));

  const results: SyncResult['pageTypes'] = [];
  for (const pageType of sync.pageTypes) {
    const allPages = await cms.listAll(pageType, sync.limit);
    const pages = filterAndSortPages(allPages, sync.criteria, sync.operator, sync.sort, sync.order);
    const hashes = await Promise.all(pages.map((page) => pageHash(key, spreadsheetId, page)));
    const values = pagesToSheetValues(pages, sync.language, sync.selectedColumns?.[pageType], hashes);
    await sheets.writeValues(spreadsheetId, sheetTitleFor(pageType), values);
    results.push({ pageType, total: allPages.length, exported: pages.length, columns: values[0]?.length ?? 0 });
  }

  return { spreadsheetId, spreadsheetUrl: sheets.spreadsheetUrl(spreadsheetId), pageTypes: results };
}

// Every row must carry a _signature minted at export time. Before a row is
// applied, the current CMS page is fetched and its full hash is recomputed: a
// mismatch means the page changed since the export (or the signature was forged
// or copied from another spreadsheet), so the row is skipped as a conflict.
// After a successful update the cell is refreshed with the new signature so the
// sheet stays importable. The edit-trigger callback re-reads only the rows it
// reported as changed; the admin action re-reads the whole sheet. In both
// cases row content comes from the sheet, never from the caller.
async function importFromSheet(cms: CmsClient, sheets: GoogleSheetsClient, sync: SyncRequest, env: PluginEnv): Promise<ImportResult> {
  if (!sync.spreadsheetId) throw new GoogleSheetsError('Paste a spreadsheet id before importing.', 400);
  const key = integrityKey(env);

  const results: ImportResult['pageTypes'] = [];
  for (const pageType of sync.pageTypes) {
    const title = sheetTitleFor(pageType);
    let headerRow: string[];
    let updates: RowUpdate[];
    if (sync.rowNumbers?.length) {
      const { headers, rows } = await sheets.readRows(sync.spreadsheetId, title, sync.rowNumbers);
      headerRow = headers;
      updates = sheetRowsToUpdates(headers, rows, pageType, sync.language);
    } else {
      const values = await sheets.readValues(sync.spreadsheetId, title);
      headerRow = values[0] ?? [];
      updates = sheetValuesToUpdates(values, pageType, sync.language);
    }
    const signatureColumn = headerRow.findIndex((header) => header.trim() === SIGNATURE_COLUMN);
    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];
    const renewals: Array<{ row: number; column: number; value: string }> = [];

    for (const update of updates) {
      const { rowNumber } = update;
      if (update.id === null || update.error) {
        skipped += 1;
        errors.push(`Row ${rowNumber}: ${update.error ?? 'invalid row'}`);
        continue;
      }
      if (!update.signature) {
        skipped += 1;
        errors.push(`Row ${rowNumber}: missing _signature - re-export this sheet to enable verified imports`);
        continue;
      }
      try {
        const current = await cms.get(update.id);
        if ((current.page_type ?? '') !== pageType) {
          skipped += 1;
          errors.push(`Row ${rowNumber}: page ${update.id} is not a "${pageType}" page`);
          continue;
        }
        const expected = await pageHash(key, sync.spreadsheetId, current);
        if (!hashIncludesSignature(expected, update.signature)) {
          skipped += 1;
          errors.push(`Row ${rowNumber}: conflict - page ${update.id} changed in the CMS after this sheet was exported; re-export before editing this row`);
          continue;
        }
        const saved = await cms.update(update.id, { ...update.input, version_action: 'update from google sheet' });
        updated += 1;
        if (signatureColumn !== -1) {
          renewals.push({ row: rowNumber, column: signatureColumn + 1, value: pageSignature(await pageHash(key, sync.spreadsheetId, saved)) });
        }
      } catch (error) {
        skipped += 1;
        errors.push(`Row ${rowNumber}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    await sheets.updateCells(sync.spreadsheetId, title, renewals);
    results.push({ pageType, rows: updates.length, updated, skipped, errors });
  }

  return {
    spreadsheetId: sync.spreadsheetId,
    spreadsheetUrl: sheets.spreadsheetUrl(sync.spreadsheetId),
    pageTypes: results,
    ok: results.every((result) => result.errors.length === 0),
  };
}

function integrityKey(env: PluginEnv): string {
  // PLUGIN_SECRET is already required to reach the CMS, never shared with
  // Apps Script or sheet editors, and rotating it invalidates outstanding
  // sheet tokens - exactly the lifecycle the row hashes need.
  if (!env.PLUGIN_SECRET) throw new CmsNotConfiguredError();
  return env.PLUGIN_SECRET;
}

function syncRequestFromForm(form: FormData, env: PluginEnv): SyncRequest {
  const pageTypes = parsePageTypes(String(form.get('page_types') ?? '')) || configuredPageTypes(env);
  if (!pageTypes.length) throw new GoogleSheetsError('Add page types to SYNC_PAGE_TYPES or the form before syncing.', 400);
  const limit = Number(form.get('limit') ?? 500);
  return {
    spreadsheetId: spreadsheetIdFromInput(String(form.get('spreadsheet_id') ?? '')),
    pageTypes,
    language: String(form.get('language') ?? env.DEFAULT_LANGUAGE ?? 'en').trim() || 'en',
    pluginHost: String(form.get('plugin_host') ?? '').trim(),
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 5000) : 500,
    criteria: parseCriteria(form),
    operator: parseOperator(form.get('operator')),
    sort: parseSort(form.get('sort')),
    order: parseOrder(form.get('order')),
    selectedColumns: selectedColumnsFromForm(form, pageTypes),
  };
}

// The callback payload is treated as a notification only - which spreadsheet
// and which tab changed. Row content is always re-read from the Sheets API,
// so a caller holding the webhook secret cannot inject values that were never
// in the spreadsheet.
function syncRequestFromCallback(payload: SheetCallbackPayload | null, env: PluginEnv): SyncRequest {
  if (!payload || typeof payload !== 'object') throw new GoogleSheetsError('Invalid callback payload.', 400);
  const pageTypes = callbackPageTypes(payload);
  if (!pageTypes || !pageTypes.length) throw new GoogleSheetsError('Callback payload must include pageType or sheetName.', 400);
  const spreadsheetId = spreadsheetIdFromInput(String(payload.spreadsheetId ?? ''));
  if (!spreadsheetId) throw new GoogleSheetsError('Callback payload must include spreadsheetId.', 400);
  const rowNumbers = callbackRowNumbers(payload);
  if (!rowNumbers.length) throw new GoogleSheetsError('Callback payload must include rowNumbers.', 400);
  return {
    spreadsheetId,
    pageTypes,
    language: String(env.DEFAULT_LANGUAGE ?? 'en').trim() || 'en',
    pluginHost: '',
    limit: 500,
    criteria: [],
    operator: 'AND',
    sort: 'updated_at',
    order: 'DESC',
    rowNumbers,
  };
}

function callbackRowNumbers(payload: SheetCallbackPayload): number[] {
  if (!Array.isArray(payload.rowNumbers)) return [];
  const numbers = payload.rowNumbers
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 2);
  const unique = [...new Set(numbers)].sort((left, right) => left - right);
  return unique.slice(0, MAX_CALLBACK_ROWS);
}

function selectedColumnsFromForm(form: FormData, pageTypes: string[]): Record<string, string[]> | undefined {
  if (String(form.get('columns_configured') ?? '') !== '1') return undefined;
  const selected: Record<string, string[]> = {};
  for (const pageType of pageTypes) {
    const columns = form.getAll(`column:${pageType}`)
      .map((value) => typeof value === 'string' ? value.trim() : '')
      .filter(Boolean);
    selected[pageType] = [...new Set(['id', ...columns])];
  }
  return selected;
}

async function syncViewData(env: PluginEnv, params: URLSearchParams): Promise<Record<string, unknown>> {
  const pageTypes = params.get('page_types') || configuredPageTypes(env).join(', ');
  const spreadsheetId = params.get('spreadsheet_id') || '';
  const operator = params.get('operator') || 'AND';
  const sort = params.get('sort') || 'updated_at';
  const order = params.get('order') || 'DESC';
  const pluginHost = params.get('plugin_host') || '';
  const limit = Number(params.get('limit') ?? 500);
  const ready = !!(env.CMS_URL && env.PLUGIN_SECRET && (env.GOOGLE_ACCESS_TOKEN || (env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_PRIVATE_KEY)));
  const criteriaIndexes = criteriaIndexesFromParams(params);
  const maxCriterionIndex = criteriaIndexes.reduce((max, index) => Math.max(max, index), 0);
  return {
    ready,
    callbackReady: !!env.SHEET_WEBHOOK_SECRET,
    spreadsheetId,
    pageTypes,
    pluginHost,
    serviceAccountEmail: env.GOOGLE_SERVICE_ACCOUNT_EMAIL ?? '',
    operatorOptions: options(['AND', 'OR', 'NOT'], operator),
    sortOptions: options(['updated_at', 'created_at', 'name', 'weight', 'id'], sort, {
      updated_at: 'Updated',
      created_at: 'Created',
      name: 'Name',
      weight: 'Weight',
      id: 'ID',
    }),
    orderOptions: options(['DESC', 'ASC'], order, { DESC: 'Desc', ASC: 'Asc' }),
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 5000) : 500,
    criteriaRows: (criteriaIndexes.length ? criteriaIndexes : [1]).map((index) => ({
      index,
      search: params.get(`search${index}`) || '',
      path: params.get(`path${index}`) || '',
    })),
    nextCriterionIndex: Math.max(2, maxCriterionIndex + 1),
    adminScriptSrc: `/admin/plugins/${PLUGIN_ID}${ADMIN_SCRIPT_ASSET}`,
  };
}

function criteriaIndexesFromParams(params: URLSearchParams): number[] {
  const indexes = new Set<number>();
  for (const key of params.keys()) {
    const match = key.match(/^(?:search|path)(\d+)$/);
    if (match) indexes.add(Number(match[1]));
  }
  return [...indexes].sort((left, right) => left - right);
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

    <div class="mt-4 max-w-5xl rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <div class="mb-3">
        <h2 class="text-lg font-bold text-gray-900">Setup</h2>
        <p class="mt-1 text-sm text-gray-500">Do these once per spreadsheet, in order.</p>
      </div>
      <div class="space-y-3">
        <div class="flex gap-3">
          <div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-semibold text-indigo-700">1</div>
          <p class="text-sm text-gray-700">Create a spreadsheet on Google Sheets: <a href="https://sheets.new" target="_blank" rel="noopener noreferrer" class="font-semibold text-indigo-600 underline">sheets.new</a>.</p>
        </div>
        <div class="flex gap-3">
          <div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-semibold text-indigo-700">2</div>
          <div class="min-w-0 flex-1">
            <p class="text-sm text-gray-700">Click Share in the spreadsheet and add this service account as an Editor.</p>
            {% if serviceAccountEmail %}
              <input readonly value="{{ serviceAccountEmail | escape }}" onclick="this.select()"
                class="mt-2 block w-full max-w-md rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 font-mono text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500">
            {% else %}
              <p class="mt-1 text-sm text-amber-600">Set GOOGLE_SERVICE_ACCOUNT_EMAIL to show the address to share with.</p>
            {% endif %}
          </div>
        </div>
        <div class="flex gap-3">
          <div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-semibold text-indigo-700">3</div>
          <p class="text-sm text-gray-700">Copy the spreadsheet's share link and paste it into <span class="font-semibold">Spreadsheet ID or URL</span> below.</p>
        </div>
        <div class="flex gap-3">
          <div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-semibold text-indigo-700">4</div>
          <p class="text-sm text-gray-700">Run Preview, choose the columns, then export. On the export-complete page, copy the Apps Script callback generated for that spreadsheet.</p>
        </div>
        <div class="flex gap-3">
          <div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-semibold text-indigo-700">5</div>
          <p class="text-sm text-gray-700">In the spreadsheet, open Extensions &gt; Apps Script, paste the callback code, then open Triggers (clock icon) &gt; Add Trigger, choose function <span class="font-mono">onCmsSheetEdit</span>, event source "From spreadsheet", event type "On edit", then Save.</p>
        </div>
      </div>
    </div>

    <form id="sheet-sync-form" method="post" class="mt-4 max-w-5xl space-y-5 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <label class="block">
        <span class="block text-sm font-medium text-gray-700 mb-1">Spreadsheet ID or URL</span>
        <input name="spreadsheet_id" value="{{ spreadsheetId | escape }}" required placeholder="Paste the share link from Step 1-3 above"
          class="block min-w-0 w-full max-w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
      </label>

      <label class="block">
        <span class="block text-sm font-medium text-gray-700 mb-1">Page types</span>
        <input name="page_types" value="{{ pageTypes | escape }}" placeholder="contact, event, guest" data-sheet-page-types
          class="block min-w-0 w-full max-w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
      </label>

      <label class="block">
        <span class="block text-sm font-medium text-gray-700 mb-1">Max pages to export</span>
        <input type="number" min="1" max="5000" name="limit" value="{{ limit }}"
          class="block min-w-0 w-full max-w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
        <span class="mt-1 block text-xs text-gray-500">Pages beyond this count are not fetched or exported.</span>
      </label>

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

      <div class="rounded-xl border border-gray-200 bg-gray-50 p-4">
        <div class="mb-3">
          <h2 class="text-sm font-semibold text-gray-900">Search criteria</h2>
          <p class="mt-1 text-xs text-gray-500">Filter which pages get exported. Leave empty to export all pages of each type.</p>
        </div>
        <div id="sheet-sync-criteria" class="grid gap-3">
          {% for row in criteriaRows %}
            <div data-criterion-row class="rounded-lg border border-gray-200 bg-white p-3">
              <div class="mb-2 flex items-center justify-between gap-3">
                <span data-criterion-number class="text-sm font-semibold text-gray-500">#{{ row.index }}</span>
                <button type="button" data-remove-criterion
                  class="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-red-600">
                  &times;
                </button>
              </div>
              <div class="grid gap-3 sm:grid-cols-2">
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
            </div>
          {% endfor %}
        </div>

        <template id="sheet-sync-criterion-template">
          <div data-criterion-row class="rounded-lg border border-gray-200 bg-white p-3">
            <div class="mb-2 flex items-center justify-between gap-3">
              <span data-criterion-number class="text-sm font-semibold text-gray-500">#__INDEX__</span>
              <button type="button" data-remove-criterion
                class="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-red-600">
                &times;
              </button>
            </div>
            <div class="grid gap-3 sm:grid-cols-2">
              <label class="block">
                <span class="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-500">Search</span>
                <input type="search" name="search__INDEX__" value="" placeholder="name email company"
                  class="h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-700 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500">
              </label>
              <label class="block">
                <span class="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-500">Path</span>
                <input type="text" name="path__INDEX__" value="" placeholder="position[*].organization_name"
                  class="h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-700 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500">
              </label>
            </div>
          </div>
        </template>

        <button type="button" id="sheet-sync-add-criterion"
          class="mt-3 inline-flex h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-700 hover:bg-gray-50">
          Add Criterion
        </button>
      </div>

      <div class="flex flex-wrap items-center gap-3 pt-2">
        <button type="submit" name="action" value="preview" formnovalidate
          class="inline-flex h-10 items-center justify-center rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-700">
          Preview
        </button>
        <button type="submit" name="action" value="import"
          class="inline-flex h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-700 hover:bg-gray-50">
          Import from Sheet
        </button>
      </div>
    </form>

    <script nonce="{{ nonce }}">
      (() => {
        const criteria = document.getElementById('sheet-sync-criteria');
        const template = document.getElementById('sheet-sync-criterion-template');
        const addButton = document.getElementById('sheet-sync-add-criterion');
        if (!criteria || !template || !addButton) return;
        let nextIndex = {{ nextCriterionIndex }};

        const updateRemoveButtons = () => {
          const rows = criteria.querySelectorAll('[data-criterion-row]');
          rows.forEach((row) => {
            const button = row.querySelector('[data-remove-criterion]');
            if (button) button.disabled = rows.length <= 1;
          });
        };

        addButton.addEventListener('click', () => {
          const html = template.innerHTML.replaceAll('__INDEX__', String(nextIndex++));
          criteria.insertAdjacentHTML('beforeend', html);
          updateRemoveButtons();
        });

        criteria.addEventListener('click', (event) => {
          const target = event.target instanceof Element ? event.target : null;
          const button = target ? target.closest('[data-remove-criterion]') : null;
          if (!button) return;
          const rows = criteria.querySelectorAll('[data-criterion-row]');
          if (rows.length <= 1) return;
          const row = button.closest('[data-criterion-row]');
          if (row) row.remove();
          updateRemoveButtons();
        });

        updateRemoveButtons();
      })();
    </script>

    <div class="mt-5 max-w-5xl rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <div class="mb-3">
        <h2 class="text-lg font-bold text-gray-900">Callback host</h2>
        <p class="mt-1 text-sm text-gray-500">Saved in this browser and used when the export-complete page builds the Apps Script callback.</p>
      </div>
      <label class="mb-4 block">
        <span class="block text-sm font-medium text-gray-700 mb-1">Plugin host</span>
        <input name="plugin_host" form="sheet-sync-form" value="{{ pluginHost | escape }}" placeholder="https://worker-cms-plugin-google-sheet.example.workers.dev" data-sheet-plugin-host
          class="block min-w-0 w-full max-w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
      </label>
      <p class="text-xs text-gray-500">The Apps Script callback is shown after export completes, when the plugin has the spreadsheet ID needed to generate a scoped token.</p>
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

async function exportSummary(result: SyncResult, sync: SyncRequest, env: PluginEnv): Promise<string> {
  const appScriptCode = appsScriptTemplate({
    pluginHost: sync.pluginHost || 'https://YOUR_PLUGIN_HOST',
    callbackToken: env.SHEET_WEBHOOK_SECRET
      ? await callbackToken(env.SHEET_WEBHOOK_SECRET, result.spreadsheetId)
      : 'YOUR_SHEET_CALLBACK_TOKEN',
  });
  return `<div class="space-y-4">
    ${notice('Spreadsheet ready', `<a class="font-semibold text-indigo-700 hover:text-indigo-900" href="${esc(result.spreadsheetUrl)}">${esc(result.spreadsheetId)}</a>`, 'green')}
    ${copyField('Published sheet URL', result.spreadsheetUrl)}
    ${copyCodeBlock('Apps Script callback', appScriptCode)}
    ${summaryTable(['Page type', 'Fetched', 'Exported', 'Columns'], result.pageTypes.map((item) => [item.pageType, String(item.total), String(item.exported), String(item.columns)]))}
  </div>`;
}

function previewView(sync: SyncRequest, result: SyncPreviewResult): string {
  return `<form method="post" class="space-y-4">
    ${hiddenSyncFields(sync)}
    <input type="hidden" name="columns_configured" value="1">
    ${result.pageTypes.map((item) => columnPicker(item, sync.selectedColumns?.[item.pageType])).join('')}
    <div class="flex flex-wrap items-center gap-3 pt-2">
      <button type="submit" name="action" value="export"
        class="inline-flex h-10 items-center justify-center rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-700">
        Export selected columns
      </button>
      <a href="/admin/plugins/${PLUGIN_ID}/sync" class="inline-flex h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-700 hover:bg-gray-50">Back</a>
    </div>
  </form>`;
}

function columnPicker(item: SyncPreviewResult['pageTypes'][number], selected: string[] | undefined): string {
  const selectedSet = selected ? new Set(selected) : null;
  return `<div class="rounded-xl border border-gray-200 bg-white shadow-sm">
    <div class="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-4 py-3">
      <div>
        <h2 class="text-lg font-bold text-gray-900">${esc(item.pageType)}</h2>
        <p class="mt-1 text-sm text-gray-500">${item.exported} of ${item.total} pages matched, ${item.columns.length} columns available.</p>
      </div>
      <div class="flex shrink-0 gap-2">
        <button type="submit" name="action" value="select_all:${esc(item.pageType)}"
          class="inline-flex h-8 items-center justify-center rounded-lg border border-gray-300 bg-white px-3 text-xs font-semibold text-gray-700 hover:bg-gray-50">
          Select all
        </button>
        <button type="submit" name="action" value="clear_all:${esc(item.pageType)}"
          class="inline-flex h-8 items-center justify-center rounded-lg border border-gray-300 bg-white px-3 text-xs font-semibold text-gray-700 hover:bg-gray-50">
          Clear all
        </button>
      </div>
    </div>
    <div class="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-3">
      ${item.columns.map((column) => columnCheckbox(item.pageType, column, selectedSet ? selectedSet.has(column) : true)).join('')}
    </div>
  </div>`;
}

function columnCheckbox(pageType: string, column: string, checked: boolean): string {
  const required = column === 'id';
  const isChecked = required || checked;
  const name = `column:${pageType}`;
  return `<label class="flex min-w-0 items-center gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700">
    <input type="checkbox" name="${esc(name)}" value="${esc(column)}" ${isChecked ? 'checked' : ''} ${required ? 'disabled' : ''}
      class="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500">
    ${required ? `<input type="hidden" name="${esc(name)}" value="${esc(column)}">` : ''}
    <span class="min-w-0 truncate">${esc(column)}</span>
  </label>`;
}

function hiddenSyncFields(sync: SyncRequest): string {
  const fields: Array<[string, string]> = [
    ['spreadsheet_id', sync.spreadsheetId],
    ['page_types', sync.pageTypes.join(', ')],
    ['language', sync.language],
    ['plugin_host', sync.pluginHost],
    ['limit', String(sync.limit)],
    ['operator', sync.operator],
    ['sort', sync.sort],
    ['order', sync.order],
  ];
  for (const criterion of sync.criteria) {
    fields.push([`search${criterion.index}`, criterion.term], [`path${criterion.index}`, criterion.path]);
  }
  return fields.map(([name, value]) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`).join('');
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
      : notice('Some rows were not imported', `Check the Notes column below. If you see <code>forbidden_page_type</code>, approve write access for this plugin in CMS plugin page-type access. Rows marked <code>conflict</code> or <code>missing _signature</code> mean the sheet is out of date - re-export to refresh it.`, 'amber')}
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

function copyField(label: string, value: string): string {
  return `<label class="block rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
    <span class="mb-2 block text-sm font-semibold text-gray-900">${esc(label)}</span>
    <input readonly value="${esc(value)}"
      class="block min-w-0 w-full max-w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 font-mono text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500">
  </label>`;
}

function copyCodeBlock(label: string, value: string): string {
  return `<label class="block rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
    <span class="mb-2 block text-sm font-semibold text-gray-900">${esc(label)}</span>
    <textarea readonly rows="18"
      class="block min-h-[22rem] w-full resize-y rounded-lg border border-gray-300 bg-gray-900 p-4 font-mono text-xs text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500">${esc(value)}</textarea>
  </label>`;
}

function notice(title: string, message: string, tone: 'green' | 'amber'): string {
  const classes = tone === 'green' ? 'border-green-200 bg-green-50 text-green-800' : 'border-amber-200 bg-amber-50 text-amber-800';
  return `<div class="rounded-xl border ${classes} px-4 py-3 text-sm"><span class="font-semibold">${esc(title)}.</span> ${message}</div>`;
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

// Header-only on purpose: a `?secret=` query parameter would end up in access
// logs and Apps Script execution logs. The header carries the per-spreadsheet
// callback token generated from SHEET_WEBHOOK_SECRET.
async function requireCallbackAuth(request: Request, webhookSecret: string, spreadsheetId: string): Promise<Response | null> {
  const presented = request.headers.get('x-sheet-webhook-secret') ?? '';
  if (presented) {
    const token = await callbackToken(webhookSecret, spreadsheetId);
    if (await secureEquals(presented, token)) return null;
  }
  return Response.json({ error: 'forbidden' }, { status: 403 });
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

// The generated trigger only *notifies* the plugin that a tab changed; the
// plugin re-reads the sheet itself. The embedded credential is a token scoped
// to this one spreadsheet (never the raw webhook secret), so it is safe in a
// container-bound script that every sheet editor can open and read.
function appsScriptTemplate(opts: { pluginHost: string; callbackToken: string }): string {
  const host = opts.pluginHost.replace(/\/+$/, '') || 'https://YOUR_PLUGIN_HOST';
  return `const CMS_PLUGIN_CALLBACK_URL = '${jsString(`${host}/__plugin/sheets/callback`)}';
const CMS_PLUGIN_CALLBACK_TOKEN = '${jsString(opts.callbackToken)}';

function onCmsSheetEdit(e) {
  const range = e && e.range;
  if (!range) return;
  const sheet = range.getSheet();
  const firstRow = Math.max(range.getRow(), 2);
  const lastRow = range.getRow() + range.getNumRows() - 1;
  if (lastRow < firstRow) return; // only the header row changed
  const rowNumbers = [];
  for (var row = firstRow; row <= lastRow; row++) rowNumbers.push(row);
  UrlFetchApp.fetch(CMS_PLUGIN_CALLBACK_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-sheet-webhook-secret': CMS_PLUGIN_CALLBACK_TOKEN },
    payload: JSON.stringify({
      spreadsheetId: SpreadsheetApp.getActive().getId(),
      pageType: sheet.getName(),
      sheetName: sheet.getName(),
      rowNumbers: rowNumbers
    }),
    muteHttpExceptions: true
  });
}`;
}

function jsString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

const ADMIN_SCRIPT = String.raw`(function () {
  var HOST_STORAGE_KEY = 'cms-plugin-google-sheet.pluginHost';

  function loadHost() {
    try {
      return window.localStorage ? window.localStorage.getItem(HOST_STORAGE_KEY) || '' : '';
    } catch (error) {
      return '';
    }
  }

  function saveHost(value) {
    try {
      if (window.localStorage) window.localStorage.setItem(HOST_STORAGE_KEY, String(value || '').trim());
    } catch (error) {
      // localStorage can be unavailable in private or embedded browsing modes.
    }
  }

  function bind(root) {
    var host = root.querySelector('[data-sheet-plugin-host]');
    if (!host) return;

    var storedHost = loadHost();
    if (!host.value && storedHost) {
      host.value = storedHost;
    } else if (host.value) {
      saveHost(host.value);
    }

    host.addEventListener('input', function () {
      saveHost(host.value);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { bind(document); });
  } else {
    bind(document);
  }
})();`;
