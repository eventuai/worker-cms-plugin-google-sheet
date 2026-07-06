import type { PluginEnv } from './types';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

interface TokenCache {
  key: string;
  token: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;

export class GoogleSheetsError extends Error {
  constructor(message: string, public status = 500) {
    super(message);
    this.name = 'GoogleSheetsError';
  }
}

export class GoogleSheetsClient {
  constructor(private readonly env: PluginEnv) {}

  async createSpreadsheet(title: string, sheetTitles: string[]): Promise<string> {
    const response = await this.googleFetch('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        properties: { title },
        sheets: sheetTitles.length ? sheetTitles.map((sheetTitle) => ({ properties: { title: sheetTitle } })) : undefined,
      }),
    });
    const result = await response.json() as { spreadsheetId?: string };
    if (!result.spreadsheetId) throw new GoogleSheetsError('Google did not return a spreadsheet id');
    return result.spreadsheetId;
  }

  async ensureSheets(spreadsheetId: string, sheetTitles: string[]): Promise<void> {
    const existing = await this.sheetTitles(spreadsheetId);
    const missing = sheetTitles.filter((title) => !existing.has(title));
    if (!missing.length) return;
    await this.googleFetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requests: missing.map((title) => ({ addSheet: { properties: { title } } })),
      }),
    });
  }

  async writeValues(spreadsheetId: string, sheetTitle: string, values: string[][]): Promise<void> {
    const range = `${quoteSheetTitle(sheetTitle)}!A1`;
    await this.clearValues(spreadsheetId, sheetTitle);
    await this.googleFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ range, majorDimension: 'ROWS', values }),
      },
    );
  }

  async clearValues(spreadsheetId: string, sheetTitle: string): Promise<void> {
    const range = `${quoteSheetTitle(sheetTitle)}!A:ZZ`;
    await this.googleFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:clear`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    );
  }

  async readValues(spreadsheetId: string, sheetTitle: string): Promise<string[][]> {
    const range = `${quoteSheetTitle(sheetTitle)}!A:ZZ`;
    const response = await this.googleFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
    );
    const result = await response.json() as { values?: unknown[][] };
    return (result.values ?? []).map((row) => row.map((cell) => String(cell ?? '')));
  }

  spreadsheetUrl(spreadsheetId: string): string {
    return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit`;
  }

  private async sheetTitles(spreadsheetId: string): Promise<Set<string>> {
    const response = await this.googleFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties.title`,
    );
    const result = await response.json() as { sheets?: Array<{ properties?: { title?: string } }> };
    return new Set((result.sheets ?? []).map((sheet) => sheet.properties?.title).filter((title): title is string => !!title));
  }

  private async googleFetch(input: string, init: RequestInit = {}): Promise<Response> {
    const token = await accessToken(this.env);
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    const response = await fetch(input, { ...init, headers });
    if (!response.ok) {
      const detail = await response.text().then((text) => text.trim().slice(0, 300)).catch(() => '');
      throw new GoogleSheetsError(`Google Sheets API returned ${response.status}${detail ? `: ${detail}` : ''}`, response.status);
    }
    return response;
  }
}

export function sheetTitleFor(pageType: string): string {
  const cleaned = pageType.replace(/[\[\]:*?/\\]/g, '-').trim() || 'pages';
  return cleaned.slice(0, 100);
}

function quoteSheetTitle(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

async function accessToken(env: PluginEnv): Promise<string> {
  if (env.GOOGLE_ACCESS_TOKEN) return env.GOOGLE_ACCESS_TOKEN;
  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_PRIVATE_KEY) {
    throw new GoogleSheetsError('Set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY, or GOOGLE_ACCESS_TOKEN for testing.');
  }

  const cacheKey = `${env.GOOGLE_SERVICE_ACCOUNT_EMAIL}:${env.GOOGLE_IMPERSONATE_EMAIL ?? ''}`;
  if (tokenCache && tokenCache.key === cacheKey && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;

  const now = Math.floor(Date.now() / 1000);
  const assertion = await signJwt(env, {
    iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: SHEETS_SCOPE,
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now,
    ...(env.GOOGLE_IMPERSONATE_EMAIL ? { sub: env.GOOGLE_IMPERSONATE_EMAIL } : {}),
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!response.ok) {
    const detail = await response.text().then((text) => text.trim().slice(0, 300)).catch(() => '');
    throw new GoogleSheetsError(`Google token request failed ${response.status}${detail ? `: ${detail}` : ''}`, response.status);
  }

  const result = await response.json() as { access_token?: string; expires_in?: number };
  if (!result.access_token) throw new GoogleSheetsError('Google token response did not include an access token');
  tokenCache = {
    key: cacheKey,
    token: result.access_token,
    expiresAt: Date.now() + Math.max((result.expires_in ?? 3600) - 60, 60) * 1000,
  };
  return result.access_token;
}

async function signJwt(env: PluginEnv, claim: Record<string, unknown>): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT', ...(env.GOOGLE_PRIVATE_KEY_ID ? { kid: env.GOOGLE_PRIVATE_KEY_ID } : {}) };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claim)}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(env.GOOGLE_PRIVATE_KEY ?? ''),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64UrlBytes(new Uint8Array(signature))}`;
}

function pemToArrayBuffer(raw: string): ArrayBuffer {
  const pem = raw.replace(/\\n/g, '\n');
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function base64UrlJson(value: unknown): string {
  return base64UrlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
