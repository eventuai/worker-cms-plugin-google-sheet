import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { filterAndSortPages } from '../src/search';
import { flattenLect, pagesToSheetValues, sheetValuesToUpdates } from '../src/sheet-mapper';
import type { PluginEnv } from '../src/types';

const plugin = worker as { fetch(request: Request, env: PluginEnv): Promise<Response> };

function env(overrides: Partial<PluginEnv> = {}): PluginEnv {
  return {
    CMS_URL: 'https://cms.test',
    PLUGIN_SECRET: 'shared-secret',
    SYNC_PAGE_TYPES: 'guest,contact',
    DEFAULT_LANGUAGE: 'en',
    GOOGLE_ACCESS_TOKEN: 'test-token',
    SHEET_WEBHOOK_SECRET: 'sheet-secret',
    ...overrides,
  };
}

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (!headers.has('x-plugin-secret')) headers.set('x-plugin-secret', 'shared-secret');
  return new Request(`https://plugin.test${path}`, { ...init, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('manifest', () => {
  it('declares configured delegated page types', async () => {
    const response = await plugin.fetch(request('/__plugin/manifest'), env({ SYNC_PAGE_TYPES: 'event, guest' }));
    const manifest = await response.json() as { contentTypes: { readTypes: string[]; writeTypes: string[] } };
    expect(manifest.contentTypes.readTypes).toEqual(['event', 'guest']);
    expect(manifest.contentTypes.writeTypes).toEqual(['event', 'guest']);
  });
});

describe('sheet mapper', () => {
  it('uses CMS edit-form names for attributes, pointers, localized fields and items', () => {
    const flat = flattenLect({
      _pointers: { mail_list: '44' },
      status: 'confirmed',
      name: { mis: 'Ada default', en: 'Ada', 'zh-hant': '愛達' },
      response: [{ status: 'yes', message: { mis: 'Default message', en: 'See you' } }],
      _blocks: [{
        _type: 'button',
        _weight: 0,
        title: 'Hero CTA',
        label: { mis: 'Default RSVP', en: 'RSVP now' },
        action: [{ label: { mis: 'Open' }, url: 'https://example.com' }],
      }],
    }, 'en');

    expect(flat).toMatchObject({
      '*mail_list': '44',
      '@status': 'confirmed',
      '.name|mis': 'Ada default',
      '.name|en': 'Ada',
      '.name|zh-hant': '愛達',
      '.response[0]@status': 'yes',
      '.response[0].message|mis': 'Default message',
      '.response[0].message|en': 'See you',
      '@_blocks[0]@_type': 'button',
      '@_blocks[0]@_weight': '0',
      '@_blocks[0]@title': 'Hero CTA',
      '@_blocks[0].label|mis': 'Default RSVP',
      '@_blocks[0].label|en': 'RSVP now',
      '@_blocks[0].action[0].label|mis': 'Open',
      '@_blocks[0].action[0]@url': 'https://example.com',
    });
    expect(flat).not.toHaveProperty('@_blocks_json');
  });

  it('builds CMS updates from edited sheet rows', () => {
    const [update] = sheetValuesToUpdates([
      [
        'id',
        'page_type',
        'name',
        'slug',
        'weight',
        '*mail_list',
        '@status',
        '.name|mis',
        '.name|en',
        '.response[0]@status',
        '@_blocks[0]@_type',
        '@_blocks[0]@_weight',
        '@_blocks[0]@title',
        '@_blocks[0].label|mis',
        '@_blocks[0].action[0].label|mis',
        '@_blocks[0].action[0]@url',
      ],
      [
        '11',
        'guest',
        'Ada Lovelace',
        'ada',
        '7',
        '44',
        'confirmed',
        'Ada default',
        'Ada',
        'yes',
        'button',
        '0',
        'Hero CTA',
        'Default RSVP',
        'Open',
        'https://example.com',
      ],
    ], 'guest', 'en');

    expect(update.id).toBe(11);
    expect(update.input).toMatchObject({ page_type: 'guest', name: 'Ada Lovelace', slug: 'ada', weight: 7 });
    expect(update.input.lect).toEqual({
      _pointers: { mail_list: '44' },
      status: 'confirmed',
      name: { mis: 'Ada default', en: 'Ada' },
      response: [{ status: 'yes' }],
      _blocks: [{
        _type: 'button',
        _weight: '0',
        title: 'Hero CTA',
        label: { mis: 'Default RSVP' },
        action: [{ label: { mis: 'Open' }, url: 'https://example.com' }],
      }],
    });
  });

  it('limits exported sheet values to selected columns while keeping id', () => {
    const values = pagesToSheetValues([{
      id: 11,
      page_type: 'guest',
      name: 'Ada Guest',
      slug: 'ada',
      weight: 2,
      start: null,
      end: null,
      timezone: null,
      page_id: null,
      updated_at: '2026-07-06',
      lect: { status: 'confirmed', name: { en: 'Ada' } },
    }], 'en', ['name', '@status']);

    expect(values).toEqual([
      ['id', 'name', '@status'],
      ['11', 'Ada Guest', 'confirmed'],
    ]);
  });
});

describe('criteria filtering', () => {
  const pages = [
    {
      id: 11,
      page_type: 'guest',
      name: 'Ada Guest',
      slug: 'ada',
      weight: 2,
      start: null,
      end: null,
      timezone: null,
      page_id: null,
      updated_at: '2026-07-06',
      lect: { status: 'confirmed', name: { en: 'Ada' }, position: [{ organization_name: { en: 'Analytical Engines' } }] },
    },
    {
      id: 12,
      page_type: 'guest',
      name: 'Grace Guest',
      slug: 'grace',
      weight: 1,
      start: null,
      end: null,
      timezone: null,
      page_id: null,
      updated_at: '2026-07-05',
      lect: { status: 'declined', name: { en: 'Grace' }, position: [{ organization_name: { en: 'Navy' } }] },
    },
  ];

  it('matches search/path criteria like advanced search', () => {
    const result = filterAndSortPages(pages, [{ index: 1, term: 'navy', path: 'position[*].organization_name' }], 'AND', 'updated_at', 'DESC');
    expect(result.map((page) => page.id)).toEqual([12]);
  });

  it('supports NOT as base criterion minus exclusions', () => {
    const result = filterAndSortPages(pages, [
      { index: 1, term: 'guest', path: '' },
      { index: 2, term: 'declined', path: 'status' },
    ], 'NOT', 'name', 'ASC');
    expect(result.map((page) => page.id)).toEqual([11]);
  });
});

describe('admin sync', () => {
  it('requires the plugin secret for admin routes', async () => {
    const response = await plugin.fetch(new Request('https://plugin.test/__plugin/admin/sync'), env());
    expect(response.status).toBe(403);
  });

  it('renders the sync page as a client view with the webhook secret applied to Apps Script', async () => {
    const response = await plugin.fetch(request('/__plugin/admin/sync?plugin_host=https%3A%2F%2Fplugin.example&page_types=guest&language=mis'), env());
    const data = await response.json() as { appScriptCode: string; webhookSecret: string; pluginHost: string; adminScriptSrc: string };

    expect(response.headers.get('x-cms-client-view')).toBe('1');
    expect(response.headers.get('x-cms-view-path')).toBe('/templates/sync.json');
    expect(data.webhookSecret).toBe('sheet-secret');
    expect(data.pluginHost).toBe('https://plugin.example');
    expect(data.appScriptCode).toContain("const CMS_PLUGIN_CALLBACK_URL = 'https://plugin.example/__plugin/sheets/callback';");
    expect(data.appScriptCode).toContain("const CMS_PLUGIN_WEBHOOK_SECRET = 'sheet-secret';");
    expect(data.appScriptCode).toContain('const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0]');
    expect(data.appScriptCode).toContain('rows: rows');
    expect(data.appScriptCode).not.toContain('CMS_PLUGIN_LANGUAGE');
    expect(data.adminScriptSrc).toBe('/admin/plugins/google-sheet/assets/sheet-sync-admin.js');
  });

  it('serves the sync client view files and admin asset', async () => {
    const template = await plugin.fetch(request('/__plugin/admin/views/templates/sync.json'), env());
    const section = await plugin.fetch(request('/__plugin/admin/views/sections/sync.liquid'), env());
    const asset = await plugin.fetch(new Request('https://plugin.test/assets/sheet-sync-admin.js'), env());

    expect(template.headers.get('content-type')).toContain('application/json');
    expect(await template.text()).toContain('"sync"');
    const sectionHtml = await section.text();
    expect(sectionHtml).toContain('data-sheet-plugin-host');
    expect(sectionHtml).toContain('name="plugin_host"');
    expect(sectionHtml).toContain('Preview');
    expect(sectionHtml).not.toContain('data-sheet-language');
    expect(sectionHtml).not.toContain('>Language<');
    expect(sectionHtml).not.toContain('Export to Sheet');
    expect(asset.headers.get('content-type')).toContain('text/javascript');
    const assetScript = await asset.text();
    expect(assetScript).toContain('data-sheet-apps-script');
    expect(assetScript).toContain('cms-plugin-google-sheet.pluginHost');
    expect(assetScript).toContain('localStorage.setItem');
    expect(assetScript).toContain('sheet.getRange(firstDataRow, 1, changedRowCount, lastColumn).getValues()');
    expect(assetScript).not.toContain('CMS_PLUGIN_LANGUAGE');
  });

  it('previews export columns before writing to Google Sheets', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      const parsed = new URL(url);

      if (parsed.hostname === 'cms.test' && parsed.pathname === '/__cms/pages') {
        return Response.json({
          total: 1,
          pages: [{
            id: 11,
            page_type: 'guest',
            name: 'Ada Guest',
            slug: 'guest-ada',
            weight: 5,
            start: null,
            end: null,
            timezone: '+0800',
            page_id: null,
            updated_at: '2026-07-06',
            lect: { status: 'confirmed', name: { en: 'Ada' } },
          }],
        });
      }

      throw new Error(`Unexpected fetch ${url}`);
    }));

    const body = new URLSearchParams({ action: 'preview', page_types: 'guest', language: 'en' });
    const response = await plugin.fetch(request('/__plugin/admin/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    }), env());
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('Preview export columns');
    expect(html).toContain('name="column:guest"');
    expect(html).toContain('value="@status"');
    expect(html).toContain('Export selected columns');
    expect(calls.every((url) => new URL(url).hostname === 'cms.test')).toBe(true);
  });

  it('exports configured page types to Google Sheets', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init });
      const parsed = new URL(url);

      if (parsed.hostname === 'cms.test' && parsed.pathname === '/__cms/pages') {
        const type = parsed.searchParams.get('page_type');
        return Response.json({
          total: 1,
          pages: [{
            id: type === 'guest' ? 11 : 12,
            page_type: type,
            name: type === 'guest' ? 'Ada Guest' : 'Ada Contact',
            slug: `${type}-ada`,
            weight: 5,
            start: null,
            end: null,
            timezone: '+0800',
            page_id: null,
            updated_at: '2026-07-06',
            lect: type === 'guest'
              ? { _pointers: { mail_list: '44' }, status: 'confirmed', name: { en: 'Ada' }, position: [{ organization_name: { en: 'Analytical Engines' } }] }
              : { email: [{ email: 'ada@example.com' }] },
          }],
        });
      }

      if (parsed.hostname === 'sheets.googleapis.com' && parsed.pathname.endsWith('/values/%27guest%27%21A%3AZZ:clear')) {
        return Response.json({});
      }
      if (parsed.hostname === 'sheets.googleapis.com' && parsed.pathname.endsWith('/values/%27contact%27%21A%3AZZ:clear')) {
        return Response.json({});
      }
      if (parsed.hostname === 'sheets.googleapis.com' && parsed.pathname.includes('/values/')) {
        return Response.json({ updatedRows: 2 });
      }
      if (parsed.hostname === 'sheets.googleapis.com' && parsed.pathname.endsWith('/spreadsheets')) {
        return Response.json({ spreadsheetId: 'sheet-123' });
      }
      return Response.json({ sheets: [] });
    }));

    const body = new URLSearchParams({
      action: 'export',
      page_types: 'guest,contact',
      language: 'en',
      plugin_host: 'https://plugin.example',
    });
    const response = await plugin.fetch(request('/__plugin/admin/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    }), env());
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('sheet-123');
    expect(html).toContain('Published sheet URL');
    expect(html).toContain('https://docs.google.com/spreadsheets/d/sheet-123/edit');
    expect(html).toContain('Apps Script callback');
    expect(html).toContain("const CMS_PLUGIN_CALLBACK_URL = 'https://plugin.example/__plugin/sheets/callback';");
    expect(html).toContain("const CMS_PLUGIN_WEBHOOK_SECRET = 'sheet-secret';");
    const valueUpdates = calls.filter((call) => call.init?.method === 'PUT');
    expect(valueUpdates).toHaveLength(2);
    const guestBody = JSON.parse(String(valueUpdates[0].init?.body)) as { values: string[][] };
    expect(guestBody.values[0]).toContain('*mail_list');
    expect(guestBody.values[0]).toContain('@status');
    expect(guestBody.values[0]).toContain('.name|en');
  });

  it('exports only pages matching submitted criteria', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const parsed = new URL(url);
      if (parsed.hostname === 'cms.test' && parsed.pathname === '/__cms/pages') {
        return Response.json({
          total: 2,
          pages: [
            {
              id: 11, page_type: 'guest', name: 'Ada Guest', slug: 'ada', weight: 5,
              start: null, end: null, timezone: '+0800', page_id: null, updated_at: '2026-07-06',
              lect: { status: 'confirmed', name: { en: 'Ada' } },
            },
            {
              id: 12, page_type: 'guest', name: 'Grace Guest', slug: 'grace', weight: 5,
              start: null, end: null, timezone: '+0800', page_id: null, updated_at: '2026-07-05',
              lect: { status: 'declined', name: { en: 'Grace' } },
            },
          ],
        });
      }
      if (parsed.hostname === 'sheets.googleapis.com' && parsed.pathname.includes('/values/') && init?.method === 'PUT') {
        const payload = JSON.parse(String(init.body)) as { values: string[][] };
        expect(payload.values.map((row) => row[0])).toEqual(['id', '11']);
        return Response.json({ updatedRows: 2 });
      }
      if (parsed.hostname === 'sheets.googleapis.com' && parsed.pathname.endsWith('/spreadsheets')) {
        return Response.json({ spreadsheetId: 'sheet-123' });
      }
      return Response.json({});
    }));

    const body = new URLSearchParams({
      action: 'export',
      page_types: 'guest',
      language: 'en',
      search1: 'confirmed',
      path1: 'status',
      operator: 'AND',
    });
    const response = await plugin.fetch(request('/__plugin/admin/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    }), env());
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('1');
  });

  it('exports only selected preview columns', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const parsed = new URL(url);
      if (parsed.hostname === 'cms.test' && parsed.pathname === '/__cms/pages') {
        return Response.json({
          total: 1,
          pages: [{
            id: 11,
            page_type: 'guest',
            name: 'Ada Guest',
            slug: 'ada',
            weight: 5,
            start: null,
            end: null,
            timezone: '+0800',
            page_id: null,
            updated_at: '2026-07-06',
            lect: { status: 'confirmed', name: { en: 'Ada' }, hidden: 'skip me' },
          }],
        });
      }
      if (parsed.hostname === 'sheets.googleapis.com' && parsed.pathname.includes('/values/') && init?.method === 'PUT') {
        const payload = JSON.parse(String(init.body)) as { values: string[][] };
        expect(payload.values).toEqual([
          ['id', 'name', '@status'],
          ['11', 'Ada Guest', 'confirmed'],
        ]);
        return Response.json({ updatedRows: 2 });
      }
      if (parsed.hostname === 'sheets.googleapis.com' && parsed.pathname.endsWith('/spreadsheets')) {
        return Response.json({ spreadsheetId: 'sheet-123' });
      }
      return Response.json({});
    }));

    const body = new URLSearchParams({
      action: 'export',
      page_types: 'guest',
      language: 'en',
      columns_configured: '1',
    });
    body.append('column:guest', 'id');
    body.append('column:guest', 'name');
    body.append('column:guest', '@status');
    const response = await plugin.fetch(request('/__plugin/admin/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    }), env());
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('3');
  });

  it('imports edited sheet rows into CMS page updates', async () => {
    const cmsUpdates: Array<{ id: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const parsed = new URL(url);
      if (parsed.hostname === 'sheets.googleapis.com' && parsed.pathname.includes('/values/')) {
        return Response.json({
          values: [
            ['id', 'page_type', 'name', 'slug', 'weight', '*mail_list', '@status', '.name|en'],
            ['11', 'guest', 'Ada Guest', 'ada-guest', '9', '44', 'confirmed', 'Ada'],
          ],
        });
      }
      const updateMatch = parsed.pathname.match(/^\/__cms\/pages\/(\d+)$/);
      if (parsed.hostname === 'cms.test' && updateMatch && init?.method === 'PUT') {
        cmsUpdates.push({ id: updateMatch[1], body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return Response.json({ page: { id: Number(updateMatch[1]) } });
      }
      return Response.json({});
    }));

    const body = new URLSearchParams({ action: 'import', spreadsheet_id: 'sheet-123', page_types: 'guest', language: 'en' });
    const response = await plugin.fetch(request('/__plugin/admin/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    }), env());

    expect(response.status).toBe(200);
    expect(cmsUpdates).toHaveLength(1);
    expect(cmsUpdates[0].id).toBe('11');
    expect(cmsUpdates[0].body).toMatchObject({
      page_type: 'guest',
      name: 'Ada Guest',
      slug: 'ada-guest',
      weight: 9,
      version_action: 'update from google sheet',
      lect: { _pointers: { mail_list: '44' }, status: 'confirmed', name: { en: 'Ada' } },
    });
  });

  it('imports edited rows from an authenticated sheet callback', async () => {
    const cmsUpdates: Array<{ id: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const parsed = new URL(url);
      if (parsed.hostname === 'sheets.googleapis.com' && parsed.pathname.includes('/values/')) {
        return Response.json({
          values: [
            ['id', 'page_type', 'name', '.name|mis', '@status'],
            ['11', 'guest', 'Ada Guest', 'Ada default', 'confirmed'],
          ],
        });
      }
      const updateMatch = parsed.pathname.match(/^\/__cms\/pages\/(\d+)$/);
      if (parsed.hostname === 'cms.test' && updateMatch && init?.method === 'PUT') {
        cmsUpdates.push({ id: updateMatch[1], body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return Response.json({ page: { id: Number(updateMatch[1]) } });
      }
      return Response.json({});
    }));

    const response = await plugin.fetch(new Request('https://plugin.test/__plugin/sheets/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sheet-webhook-secret': 'sheet-secret' },
      body: JSON.stringify({ spreadsheetId: 'sheet-123', pageType: 'guest', language: 'mis' }),
    }), env());
    const result = await response.json() as { ok: boolean };

    expect(response.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(cmsUpdates).toHaveLength(1);
    expect(cmsUpdates[0]).toMatchObject({
      id: '11',
      body: {
        page_type: 'guest',
        name: 'Ada Guest',
        version_action: 'update from google sheet',
        lect: { name: { mis: 'Ada default' }, status: 'confirmed' },
      },
    });
  });

  it('imports row payloads from sheet callbacks without reading the whole sheet', async () => {
    const cmsUpdates: Array<{ id: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const parsed = new URL(url);
      if (parsed.hostname === 'sheets.googleapis.com') {
        throw new Error('Callback row payload should not read Google Sheets');
      }
      const updateMatch = parsed.pathname.match(/^\/__cms\/pages\/(\d+)$/);
      if (parsed.hostname === 'cms.test' && updateMatch && init?.method === 'PUT') {
        cmsUpdates.push({ id: updateMatch[1], body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return Response.json({ page: { id: Number(updateMatch[1]) } });
      }
      return Response.json({});
    }));

    const response = await plugin.fetch(new Request('https://plugin.test/__plugin/sheets/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sheet-webhook-secret': 'sheet-secret' },
      body: JSON.stringify({
        spreadsheetId: 'sheet-123',
        sheetName: 'guest',
        language: 'mis',
        headers: ['id', 'page_type', 'name', '.name|mis', '@status'],
        rows: [
          ['11', 'guest', 'Ada Guest', 'Ada default', 'confirmed'],
        ],
      }),
    }), env());
    const result = await response.json() as { ok: boolean; pageTypes: Array<{ rows: number }> };

    expect(response.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.pageTypes[0].rows).toBe(1);
    expect(cmsUpdates).toHaveLength(1);
    expect(cmsUpdates[0]).toMatchObject({
      id: '11',
      body: {
        page_type: 'guest',
        name: 'Ada Guest',
        version_action: 'update from google sheet',
        lect: { name: { mis: 'Ada default' }, status: 'confirmed' },
      },
    });
  });

  it('rejects unauthenticated sheet callbacks', async () => {
    const response = await plugin.fetch(new Request('https://plugin.test/__plugin/sheets/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spreadsheetId: 'sheet-123', pageType: 'guest' }),
    }), env());

    expect(response.status).toBe(403);
  });

  it('surfaces CMS write-scope failures instead of reporting a clean import', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const parsed = new URL(url);
      if (parsed.hostname === 'sheets.googleapis.com' && parsed.pathname.includes('/values/')) {
        return Response.json({
          values: [
            ['id', 'page_type', 'name', '@status'],
            ['11', 'guest', 'Ada Guest', 'confirmed'],
          ],
        });
      }
      if (parsed.hostname === 'cms.test' && parsed.pathname === '/__cms/pages/11' && init?.method === 'PUT') {
        return Response.json({ error: 'forbidden_page_type' }, { status: 403 });
      }
      return Response.json({});
    }));

    const body = new URLSearchParams({ action: 'import', spreadsheet_id: 'sheet-123', page_types: 'guest', language: 'en' });
    const response = await plugin.fetch(request('/__plugin/admin/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    }), env());
    const html = await response.text();

    expect(response.status).toBe(409);
    expect(html).toContain('Import needs attention');
    expect(html).toContain('forbidden_page_type');
    expect(html).toContain('Updated');
    expect(html).toContain('Skipped');
  });
});
