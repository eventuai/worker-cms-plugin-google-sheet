import { CmsApiError, CmsClient, CmsNotConfiguredError } from './cms';
import { GoogleSheetsClient, GoogleSheetsError, sheetTitleFor } from './google';
import { pagesToSheetValues, sheetValuesToUpdates } from './sheet-mapper';
import type { CmsUser, ImportResult, PluginEnv, SyncRequest, SyncResult } from './types';

const PLUGIN_ID = 'google-sheet';

export default {
  async fetch(request: Request, env: PluginEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/__plugin/manifest') return Response.json(manifest(env));

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

function manifest(env: PluginEnv): Record<string, unknown> {
  const pageTypes = configuredPageTypes(env);
  return {
    id: PLUGIN_ID,
    name: 'Google Sheet Sync',
    version: '0.1.0',
    nav: [{ label: 'Google Sheets', href: 'sync', roles: ['admin', 'editor'], group: 'settings' }],
    permissions: [
      { value: 'google-sheet:sync', label: 'Google Sheet: export and import CMS pages' },
    ],
    contentTypes: {
      readTypes: pageTypes,
      writeTypes: pageTypes,
    },
  };
}

async function handleAdmin(request: Request, env: PluginEnv, url: URL): Promise<Response> {
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
      return chrome('Google Sheets import', resultView('Import complete', importSummary(result)));
    }
  }

  return chrome('Google Sheets', formView(env, url.searchParams));
}

async function exportToSheet(cms: CmsClient, sheets: GoogleSheetsClient, sync: SyncRequest): Promise<SyncResult> {
  const titles = sync.pageTypes.map(sheetTitleFor);
  const spreadsheetId = sync.spreadsheetId
    || await sheets.createSpreadsheet(`Worker CMS export ${new Date().toISOString().slice(0, 10)}`, titles);
  if (sync.spreadsheetId) await sheets.ensureSheets(spreadsheetId, titles);

  const results: SyncResult['pageTypes'] = [];
  for (const pageType of sync.pageTypes) {
    const pages = await cms.listAll(pageType, sync.limit);
    const values = pagesToSheetValues(pages, sync.language);
    await sheets.writeValues(spreadsheetId, sheetTitleFor(pageType), values);
    results.push({ pageType, count: pages.length, columns: values[0]?.length ?? 0 });
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
        await cms.update(update.id, update.input);
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
  };
}

function formView(env: PluginEnv, params: URLSearchParams): string {
  const pageTypes = params.get('page_types') || configuredPageTypes(env).join(', ');
  const language = params.get('language') || env.DEFAULT_LANGUAGE || 'en';
  const spreadsheetId = params.get('spreadsheet_id') || '';
  const ready = !!(env.CMS_URL && env.PLUGIN_SECRET && (env.GOOGLE_ACCESS_TOKEN || (env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_PRIVATE_KEY)));

  return `<div class="px-4 py-5 sm:px-6 sm:py-8 lg:px-8">
    <div class="flex items-center justify-between gap-4 mb-4">
      <div>
        <h1 class="text-2xl font-bold text-gray-900">Google Sheets</h1>
        <p class="mt-1 text-sm text-gray-500">Export CMS pages to editable sheets and import row changes back into drafts.</p>
      </div>
    </div>

    ${ready ? '' : notice('Configuration missing', 'Set CMS_URL, PLUGIN_SECRET, and Google service-account credentials before syncing.', 'amber')}

    <form method="post" class="max-w-3xl space-y-5 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <label class="block">
        <span class="block text-sm font-medium text-gray-700 mb-1">Spreadsheet ID or URL</span>
        <input name="spreadsheet_id" value="${esc(spreadsheetId)}" placeholder="Leave blank to create a new spreadsheet"
          class="block min-w-0 w-full max-w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
      </label>

      <label class="block">
        <span class="block text-sm font-medium text-gray-700 mb-1">Page types</span>
        <input name="page_types" value="${esc(pageTypes)}" placeholder="contact, event, guest"
          class="block min-w-0 w-full max-w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
      </label>

      <div class="grid gap-4 sm:grid-cols-2">
        <label class="block">
          <span class="block text-sm font-medium text-gray-700 mb-1">Language</span>
          <input name="language" value="${esc(language)}"
            class="block min-w-0 w-full max-w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
        </label>
        <label class="block">
          <span class="block text-sm font-medium text-gray-700 mb-1">Page fetch size</span>
          <input type="number" min="1" max="500" name="limit" value="500"
            class="block min-w-0 w-full max-w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
        </label>
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
  </div>`;
}

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
    ${summaryTable(['Page type', 'Rows', 'Columns'], result.pageTypes.map((item) => [item.pageType, String(item.count), String(item.columns)]))}
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
    ${notice('Spreadsheet imported', `<a class="font-semibold text-indigo-700 hover:text-indigo-900" href="${esc(result.spreadsheetUrl)}">${esc(result.spreadsheetId)}</a>`, 'green')}
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

function requirePluginSecret(request: Request, secret: string | undefined): Response | null {
  if (!secret) return new Response('server misconfigured', { status: 500, headers: { 'cache-control': 'no-store' } });
  if (request.headers.get('x-plugin-secret') !== secret) return new Response('forbidden', { status: 403, headers: { 'cache-control': 'no-store' } });
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

function configuredPageTypes(env: PluginEnv): string[] {
  return parsePageTypes(env.SYNC_PAGE_TYPES ?? '') ?? [];
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
