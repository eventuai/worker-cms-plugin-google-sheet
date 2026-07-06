import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { pageHash } from '../src/integrity';
import { filterAndSortPages } from '../src/search';
import { flattenLect, pagesToSheetValues, sheetValuesToUpdates } from '../src/sheet-mapper';
import type { CmsPage, PluginEnv } from '../src/types';

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

function request(path: string, init: RequestInit = {}, role = 'admin'): Request {
  const headers = new Headers(init.headers);
  if (!headers.has('x-plugin-secret')) headers.set('x-plugin-secret', 'shared-secret');
  if (!headers.has('x-cms-user')) headers.set('x-cms-user', JSON.stringify({ id: 'u1', role }));
  return new Request(`https://plugin.test${path}`, { ...init, headers });
}

// Matches the page state the import-path mocks return from GET /pages/:id.
const guestPage: CmsPage = {
  id: 11,
  page_type: 'guest',
  name: 'Ada Guest',
  slug: 'ada-guest',
  weight: 9,
  start: null,
  end: null,
  timezone: null,
  page_id: null,
  updated_at: '2026-07-06',
  lect: { status: 'pending', name: { mis: 'Ada default' } },
};

function guestRowHash(spreadsheetId = 'sheet-123'): Promise<string> {
  return pageHash('shared-secret', spreadsheetId, guestPage);
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

  it('ignores the page_type cell so a row cannot retype a page', () => {
    const [update] = sheetValuesToUpdates([
      ['id', 'page_type', 'name'],
      ['11', 'event', 'Ada Guest'],
    ], 'guest', 'en');

    expect(update.input.page_type).toBe('guest');
  });

  it('captures the _hash cell without treating it as lect content', () => {
    const [update] = sheetValuesToUpdates([
      ['id', 'name', '@status', '_hash'],
      ['11', 'Ada Guest', 'confirmed', 'token-abc'],
    ], 'guest', 'en');

    expect(update.hash).toBe('token-abc');
    expect(update.input.lect).toEqual({ status: 'confirmed' });
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

describe('integrity tokens', () => {
  it('is stable across key order but changes with content and spreadsheet', async () => {
    const reordered = { ...guestPage, lect: { name: { mis: 'Ada default' }, status: 'pending' } };
    expect(await pageHash('shared-secret', 'sheet-123', reordered)).toBe(await guestRowHash());

    const edited = { ...guestPage, lect: { ...guestPage.lect, status: 'confirmed' } };
    expect(await pageHash('shared-secret', 'sheet-123', edited)).not.toBe(await guestRowHash());
    expect(await pageHash('shared-secret', 'other-sheet', guestPage)).not.toBe(await guestRowHash());
    expect(await pageHash('other-key', 'sheet-123', guestPage)).not.toBe(await guestRowHash());
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
    const response = await plugin.fetch(request('/__plugin/admin/sync?plugin_host=https%3A%2F%2Fplugin.example&page_types=guest&language=mis'), env({ GOOGLE_SERVICE_ACCOUNT_EMAIL: 'sheets-bot@project.iam.gserviceaccount.com' }));
    const data = await response.json() as {
      appScriptCode: string;
      webhookSecret: string;
      pluginHost: string;
      adminScriptSrc: string;
      serviceAccountEmail: string;
      limit: number;
      criteriaRows: Array<{ index: number; search: string; path: string }>;
      nextCriterionIndex: number;
    };

    expect(response.headers.get('x-cms-client-view')).toBe('1');
    expect(response.headers.get('x-cms-view-path')).toBe('/templates/sync.json');
    expect(data.webhookSecret).toBe('sheet-secret');
    expect(data.pluginHost).toBe('https://plugin.example');
    expect(data.serviceAccountEmail).toBe('sheets-bot@project.iam.gserviceaccount.com');
    expect(data.limit).toBe(500);
    expect(data.criteriaRows).toEqual([{ index: 1, search: '', path: '' }]);
    expect(data.nextCriterionIndex).toBe(2);
    expect(data.appScriptCode).toContain("const CMS_PLUGIN_CALLBACK_URL = 'https://plugin.example/__plugin/sheets/callback';");
    expect(data.appScriptCode).toContain("const CMS_PLUGIN_WEBHOOK_SECRET = 'sheet-secret';");
    expect(data.appScriptCode).toContain('spreadsheetId: SpreadsheetApp.getActive().getId()');
    expect(data.appScriptCode).toContain('sheetName: sheet.getName()');
    expect(data.appScriptCode).not.toContain('rows:');
    expect(data.appScriptCode).not.toContain('CMS_PLUGIN_LANGUAGE');
    expect(data.adminScriptSrc).toBe('/admin/plugins/google-sheet/assets/sheet-sync-admin.js');
  });

  it('hides the webhook secret from non-admin users', async () => {
    const response = await plugin.fetch(request('/__plugin/admin/sync', {}, 'editor'), env());
    const data = await response.json() as { webhookSecret: string; appScriptCode: string };

    expect(data.webhookSecret).toBe('');
    expect(data.appScriptCode).toContain("const CMS_PLUGIN_WEBHOOK_SECRET = 'YOUR_SHEET_WEBHOOK_SECRET';");
    expect(data.appScriptCode).not.toContain('sheet-secret');
  });

  it('derives criteria rows and the next index from whatever search/path params are present', async () => {
    const response = await plugin.fetch(request('/__plugin/admin/sync?search3=vip&path3=status&limit=2000'), env());
    const data = await response.json() as {
      criteriaRows: Array<{ index: number; search: string; path: string }>;
      nextCriterionIndex: number;
      limit: number;
    };

    expect(data.criteriaRows).toEqual([{ index: 3, search: 'vip', path: 'status' }]);
    expect(data.nextCriterionIndex).toBe(4);
    expect(data.limit).toBe(2000);
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
    expect(assetScript).toContain('SpreadsheetApp.getActive().getId()');
    expect(assetScript).not.toContain('rows: rows');
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
    expect(html).toContain('value="@status" checked');
    expect(html).toContain('Export selected columns');
    expect(html).toContain('value="select_all:guest"');
    expect(html).toContain('value="clear_all:guest"');
    expect(calls.every((url) => new URL(url).hostname === 'cms.test')).toBe(true);
  });

  it('clears and re-selects all columns for a page type from the preview buttons', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
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

    const clearBody = new URLSearchParams({ action: 'clear_all:guest', page_types: 'guest', language: 'en', columns_configured: '1' });
    clearBody.append('column:guest', 'id');
    const clearResponse = await plugin.fetch(request('/__plugin/admin/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: clearBody,
    }), env());
    const clearHtml = await clearResponse.text();

    expect(clearResponse.status).toBe(200);
    expect(clearHtml).not.toContain('value="@status" checked');
    expect(clearHtml).toContain('value="id" checked');

    const selectBody = new URLSearchParams({ action: 'select_all:guest', page_types: 'guest', language: 'en', columns_configured: '1' });
    selectBody.append('column:guest', 'id');
    const selectResponse = await plugin.fetch(request('/__plugin/admin/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: selectBody,
    }), env());
    const selectHtml = await selectResponse.text();

    expect(selectResponse.status).toBe(200);
    expect(selectHtml).toContain('value="@status" checked');
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
      return Response.json({ sheets: [] });
    }));

    const body = new URLSearchParams({
      action: 'export',
      spreadsheet_id: 'sheet-123',
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
      return Response.json({});
    }));

    const body = new URLSearchParams({
      action: 'export',
      spreadsheet_id: 'sheet-123',
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
        expect(payload.values[0]).toEqual(['id', 'name', '@status', '_hash']);
        expect(payload.values[1].slice(0, 3)).toEqual(['11', 'Ada Guest', 'confirmed']);
        expect(payload.values[1][3]).toMatch(/^[A-Za-z0-9_-]{40,}$/);
        return Response.json({ updatedRows: 2 });
      }
      return Response.json({});
    }));

    const body = new URLSearchParams({
      action: 'export',
      spreadsheet_id: 'sheet-123',
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

  it('rejects export requests with no spreadsheet id instead of silently creating one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('No Google or CMS request should be made without a spreadsheet id');
    }));

    const body = new URLSearchParams({ action: 'export', page_types: 'guest', language: 'en' });
    const response = await plugin.fetch(request('/__plugin/admin/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    }), env());
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain('spreadsheet');
  });

  it('caps fetched and exported pages at the configured limit instead of pulling everything', async () => {
    const pageFetches: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const parsed = new URL(url);

      if (parsed.hostname === 'cms.test' && parsed.pathname === '/__cms/pages') {
        pageFetches.push(url);
        const offset = Number(parsed.searchParams.get('offset'));
        const limit = Number(parsed.searchParams.get('limit'));
        const pages = Array.from({ length: limit }, (_unused, index) => ({
          id: offset + index + 1,
          page_type: 'guest',
          name: `Guest ${offset + index + 1}`,
          slug: `guest-${offset + index + 1}`,
          weight: 1,
          start: null,
          end: null,
          timezone: null,
          page_id: null,
          updated_at: '2026-07-06',
          lect: {},
        }));
        return Response.json({ total: 12, pages });
      }
      if (parsed.hostname === 'sheets.googleapis.com' && parsed.pathname.includes('/values/') && init?.method === 'PUT') {
        const payload = JSON.parse(String(init.body)) as { values: string[][] };
        expect(payload.values).toHaveLength(3);
        return Response.json({ updatedRows: 3 });
      }
      return Response.json({});
    }));

    const body = new URLSearchParams({ action: 'export', spreadsheet_id: 'sheet-123', page_types: 'guest', language: 'en', limit: '2' });
    const response = await plugin.fetch(request('/__plugin/admin/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    }), env());

    expect(response.status).toBe(200);
    expect(pageFetches).toHaveLength(1);
    const requestedLimit = new URL(pageFetches[0]).searchParams.get('limit');
    expect(requestedLimit).toBe('2');
  });

  it('imports rows whose _hash matches the current CMS page, then renews the hash cell', async () => {
    const rowHash = await guestRowHash();
    const cmsUpdates: Array<{ id: string; body: Record<string, unknown> }> = [];
    const batchUpdates: Array<Record<string, unknown>> = [];
    const savedPage = { ...guestPage, name: 'Ada Guest', lect: { status: 'confirmed', name: { en: 'Ada' } } };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const parsed = new URL(url);
      if (parsed.hostname === 'sheets.googleapis.com' && parsed.pathname.endsWith('/values:batchUpdate')) {
        batchUpdates.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({});
      }
      if (parsed.hostname === 'sheets.googleapis.com' && parsed.pathname.includes('/values/')) {
        return Response.json({
          values: [
            ['id', 'page_type', 'name', 'slug', 'weight', '*mail_list', '@status', '.name|en', '_hash'],
            ['11', 'guest', 'Ada Guest', 'ada-guest', '9', '44', 'confirmed', 'Ada', rowHash],
          ],
        });
      }
      const pageMatch = parsed.pathname.match(/^\/__cms\/pages\/(\d+)$/);
      if (parsed.hostname === 'cms.test' && pageMatch && init?.method === 'PUT') {
        cmsUpdates.push({ id: pageMatch[1], body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return Response.json({ page: savedPage });
      }
      if (parsed.hostname === 'cms.test' && pageMatch) {
        return Response.json({ page: guestPage });
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

    const renewedHash = await pageHash('shared-secret', 'sheet-123', savedPage);
    expect(batchUpdates).toHaveLength(1);
    expect(batchUpdates[0]).toMatchObject({
      valueInputOption: 'RAW',
      data: [{ range: "'guest'!I2", values: [[renewedHash]] }],
    });
  });

  it('skips rows whose _hash no longer matches the CMS page', async () => {
    const staleHash = await pageHash('shared-secret', 'sheet-123', { ...guestPage, lect: { status: 'older-state' } });
    const cmsWrites: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const parsed = new URL(url);
      if (parsed.hostname === 'sheets.googleapis.com' && parsed.pathname.includes('/values/')) {
        return Response.json({
          values: [
            ['id', 'name', '@status', '_hash'],
            ['11', 'Ada Guest', 'confirmed', staleHash],
          ],
        });
      }
      const pageMatch = parsed.pathname.match(/^\/__cms\/pages\/(\d+)$/);
      if (parsed.hostname === 'cms.test' && pageMatch && init?.method === 'PUT') {
        cmsWrites.push(pageMatch[1]);
        return Response.json({ page: guestPage });
      }
      if (parsed.hostname === 'cms.test' && pageMatch) {
        return Response.json({ page: guestPage });
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
    expect(cmsWrites).toHaveLength(0);
    expect(html).toContain('conflict');
  });

  it('skips rows without a _hash token', async () => {
    const cmsWrites: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const parsed = new URL(url);
      if (parsed.hostname === 'sheets.googleapis.com' && parsed.pathname.includes('/values/')) {
        return Response.json({
          values: [
            ['id', 'name', '@status'],
            ['11', 'Ada Guest', 'confirmed'],
          ],
        });
      }
      if (parsed.hostname === 'cms.test' && init?.method === 'PUT') {
        cmsWrites.push(parsed.pathname);
        return Response.json({ page: guestPage });
      }
      return Response.json({ page: guestPage });
    }));

    const body = new URLSearchParams({ action: 'import', spreadsheet_id: 'sheet-123', page_types: 'guest', language: 'en' });
    const response = await plugin.fetch(request('/__plugin/admin/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    }), env());
    const html = await response.text();

    expect(response.status).toBe(409);
    expect(cmsWrites).toHaveLength(0);
    expect(html).toContain('missing _hash');
  });

  it('skips rows whose id points at a page of a different type', async () => {
    const contactPage = { ...guestPage, id: 42, page_type: 'contact' };
    const rowHash = await pageHash('shared-secret', 'sheet-123', contactPage);
    const cmsWrites: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const parsed = new URL(url);
      if (parsed.hostname === 'sheets.googleapis.com' && parsed.pathname.includes('/values/')) {
        return Response.json({
          values: [
            ['id', 'name', '_hash'],
            ['42', 'Hijacked', rowHash],
          ],
        });
      }
      const pageMatch = parsed.pathname.match(/^\/__cms\/pages\/(\d+)$/);
      if (parsed.hostname === 'cms.test' && pageMatch && init?.method === 'PUT') {
        cmsWrites.push(pageMatch[1]);
        return Response.json({ page: contactPage });
      }
      if (parsed.hostname === 'cms.test' && pageMatch) {
        return Response.json({ page: contactPage });
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
    expect(cmsWrites).toHaveLength(0);
    expect(html).toContain('not a &quot;guest&quot; page');
  });

  it('imports verified rows from an authenticated sheet callback', async () => {
    const rowHash = await guestRowHash();
    const cmsUpdates: Array<{ id: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const parsed = new URL(url);
      if (parsed.hostname === 'sheets.googleapis.com' && parsed.pathname.endsWith('/values:batchUpdate')) {
        return Response.json({});
      }
      if (parsed.hostname === 'sheets.googleapis.com' && parsed.pathname.includes('/values/')) {
        return Response.json({
          values: [
            ['id', 'page_type', 'name', '.name|mis', '@status', '_hash'],
            ['11', 'guest', 'Ada Guest', 'Ada default', 'confirmed', rowHash],
          ],
        });
      }
      const pageMatch = parsed.pathname.match(/^\/__cms\/pages\/(\d+)$/);
      if (parsed.hostname === 'cms.test' && pageMatch && init?.method === 'PUT') {
        cmsUpdates.push({ id: pageMatch[1], body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return Response.json({ page: guestPage });
      }
      if (parsed.hostname === 'cms.test' && pageMatch) {
        return Response.json({ page: guestPage });
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

  it('ignores row payloads posted to the callback and re-reads the sheet instead', async () => {
    const rowHash = await guestRowHash();
    const cmsUpdates: Array<{ id: string; body: Record<string, unknown> }> = [];
    let sheetReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const parsed = new URL(url);
      if (parsed.hostname === 'sheets.googleapis.com' && parsed.pathname.endsWith('/values:batchUpdate')) {
        return Response.json({});
      }
      if (parsed.hostname === 'sheets.googleapis.com' && parsed.pathname.includes('/values/')) {
        sheetReads += 1;
        return Response.json({
          values: [
            ['id', 'name', '@status', '_hash'],
            ['11', 'Ada Guest', 'confirmed', rowHash],
          ],
        });
      }
      const pageMatch = parsed.pathname.match(/^\/__cms\/pages\/(\d+)$/);
      if (parsed.hostname === 'cms.test' && pageMatch && init?.method === 'PUT') {
        cmsUpdates.push({ id: pageMatch[1], body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return Response.json({ page: guestPage });
      }
      if (parsed.hostname === 'cms.test' && pageMatch) {
        return Response.json({ page: guestPage });
      }
      return Response.json({});
    }));

    const response = await plugin.fetch(new Request('https://plugin.test/__plugin/sheets/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sheet-webhook-secret': 'sheet-secret' },
      body: JSON.stringify({
        spreadsheetId: 'sheet-123',
        sheetName: 'guest',
        headers: ['id', 'name'],
        rows: [['999', 'Injected via payload']],
      }),
    }), env());
    const result = await response.json() as { ok: boolean };

    expect(response.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(sheetReads).toBe(1);
    expect(cmsUpdates).toHaveLength(1);
    expect(cmsUpdates[0].id).toBe('11');
    expect(JSON.stringify(cmsUpdates[0].body)).not.toContain('Injected via payload');
  });

  it('rejects unauthenticated sheet callbacks', async () => {
    const response = await plugin.fetch(new Request('https://plugin.test/__plugin/sheets/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spreadsheetId: 'sheet-123', pageType: 'guest' }),
    }), env());

    expect(response.status).toBe(403);
  });

  it('no longer accepts the webhook secret as a query parameter', async () => {
    const response = await plugin.fetch(new Request('https://plugin.test/__plugin/sheets/callback?secret=sheet-secret', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spreadsheetId: 'sheet-123', pageType: 'guest' }),
    }), env());

    expect(response.status).toBe(403);
  });

  it('surfaces CMS write-scope failures instead of reporting a clean import', async () => {
    const rowHash = await guestRowHash();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const parsed = new URL(url);
      if (parsed.hostname === 'sheets.googleapis.com' && parsed.pathname.includes('/values/')) {
        return Response.json({
          values: [
            ['id', 'page_type', 'name', '@status', '_hash'],
            ['11', 'guest', 'Ada Guest', 'confirmed', rowHash],
          ],
        });
      }
      if (parsed.hostname === 'cms.test' && parsed.pathname === '/__cms/pages/11' && init?.method === 'PUT') {
        return Response.json({ error: 'forbidden_page_type' }, { status: 403 });
      }
      if (parsed.hostname === 'cms.test' && parsed.pathname === '/__cms/pages/11') {
        return Response.json({ page: guestPage });
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
