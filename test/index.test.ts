import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { flattenLect, sheetValuesToUpdates } from '../src/sheet-mapper';
import type { PluginEnv } from '../src/types';

const plugin = worker as { fetch(request: Request, env: PluginEnv): Promise<Response> };

function env(overrides: Partial<PluginEnv> = {}): PluginEnv {
  return {
    CMS_URL: 'https://cms.test',
    PLUGIN_SECRET: 'shared-secret',
    SYNC_PAGE_TYPES: 'guest,contact',
    DEFAULT_LANGUAGE: 'en',
    GOOGLE_ACCESS_TOKEN: 'test-token',
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
      name: { en: 'Ada' },
      response: [{ status: 'yes', message: { en: 'See you' } }],
    }, 'en');

    expect(flat).toMatchObject({
      '*mail_list': '44',
      '@status': 'confirmed',
      '.name|en': 'Ada',
      '.response[0]@status': 'yes',
      '.response[0].message|en': 'See you',
    });
  });

  it('builds CMS updates from edited sheet rows', () => {
    const [update] = sheetValuesToUpdates([
      ['id', 'page_type', 'name', 'slug', 'weight', '*mail_list', '@status', '.name|en', '.response[0]@status'],
      ['11', 'guest', 'Ada Lovelace', 'ada', '7', '44', 'confirmed', 'Ada', 'yes'],
    ], 'guest', 'en');

    expect(update.id).toBe(11);
    expect(update.input).toMatchObject({ page_type: 'guest', name: 'Ada Lovelace', slug: 'ada', weight: 7 });
    expect(update.input.lect).toEqual({
      _pointers: { mail_list: '44' },
      status: 'confirmed',
      name: { en: 'Ada' },
      response: [{ status: 'yes' }],
    });
  });
});

describe('admin sync', () => {
  it('requires the plugin secret for admin routes', async () => {
    const response = await plugin.fetch(new Request('https://plugin.test/__plugin/admin/sync'), env());
    expect(response.status).toBe(403);
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
              ? { _pointers: { mail_list: '44' }, status: 'confirmed', name: { en: 'Ada' } }
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

    const body = new URLSearchParams({ action: 'export', page_types: 'guest,contact', language: 'en' });
    const response = await plugin.fetch(request('/__plugin/admin/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    }), env());
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('sheet-123');
    const valueUpdates = calls.filter((call) => call.init?.method === 'PUT');
    expect(valueUpdates).toHaveLength(2);
    const guestBody = JSON.parse(String(valueUpdates[0].init?.body)) as { values: string[][] };
    expect(guestBody.values[0]).toContain('*mail_list');
    expect(guestBody.values[0]).toContain('@status');
    expect(guestBody.values[0]).toContain('.name|en');
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
      lect: { _pointers: { mail_list: '44' }, status: 'confirmed', name: { en: 'Ada' } },
    });
  });
});
