import type { CmsPage, CmsPageInput, PluginEnv } from './types';

export class CmsApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public method: string,
    public path: string,
  ) {
    super(`CMS API ${method} ${path} ${status}: ${code}`);
    this.name = 'CmsApiError';
  }
}

export class CmsNotConfiguredError extends Error {
  constructor() {
    super('Set CMS_URL and PLUGIN_SECRET so the plugin can reach the CMS page API.');
    this.name = 'CmsNotConfiguredError';
  }
}

export class CmsClient {
  private readonly base: string;
  private readonly secret: string;
  private readonly actingUserId: string | null;

  constructor(env: PluginEnv, actingUserId: string | null = null) {
    if (!env.CMS_URL || !env.PLUGIN_SECRET) throw new CmsNotConfiguredError();
    this.base = env.CMS_URL.replace(/\/+$/, '');
    this.secret = env.PLUGIN_SECRET;
    this.actingUserId = actingUserId;
  }

  async listAll(pageType: string, limit = 500): Promise<CmsPage[]> {
    const pages: CmsPage[] = [];
    for (let offset = 0; ; offset += limit) {
      const params = new URLSearchParams({ page_type: pageType, limit: String(limit), offset: String(offset) });
      const path = `/pages?${params}`;
      const result = await this.json<{ pages: CmsPage[]; total: number }>(await this.call('GET', path), 'GET', path);
      pages.push(...result.pages);
      if (pages.length >= result.total || result.pages.length === 0) break;
    }
    return pages;
  }

  async update(id: number, input: CmsPageInput): Promise<CmsPage> {
    const path = `/pages/${id}`;
    const result = await this.json<{ page: CmsPage }>(await this.call('PUT', path, input), 'PUT', path);
    return result.page;
  }

  private call(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      'x-plugin-id': 'google-sheet',
      'x-plugin-secret': this.secret,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.actingUserId) headers['x-acting-user-id'] = this.actingUserId;
    return fetch(`${this.base}/__cms${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private async json<T>(response: Response, method: string, path: string): Promise<T> {
    if (!response.ok) {
      const code = await response.text().then((text) => {
        try {
          const parsed = JSON.parse(text) as { error?: unknown };
          return typeof parsed.error === 'string' ? parsed.error : 'error';
        } catch {
          return text.replace(/\s+/g, ' ').trim().slice(0, 160) || 'error';
        }
      }).catch(() => 'error');
      throw new CmsApiError(response.status, code, method, path);
    }
    return response.json() as Promise<T>;
  }
}
