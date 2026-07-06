import type { CmsPage } from './types';

// Column that carries the visible per-row integrity signature in exported
// sheets. It is a short slice of an HMAC (keyed on PLUGIN_SECRET) over the
// page state at export time plus the spreadsheet id, so at import time it
// serves three purposes:
// optimistic concurrency (the CMS page changed since export -> mismatch),
// tamper resistance (sheet editors cannot mint signatures for arbitrary pages),
// and spreadsheet binding (signatures copied into a different spreadsheet fail,
// because the spreadsheet id is part of the signed material).
export const SIGNATURE_COLUMN = '_signature';
export const SIGNATURE_LENGTH = 10;

export async function pageHash(key: string, spreadsheetId: string, page: CmsPage): Promise<string> {
  // Hash an explicit field list rather than the whole page object so list,
  // get, and update responses (which differ in extras like tags/updated_at)
  // all produce the same token for the same content.
  const material = canonicalJson({
    spreadsheetId,
    id: page.id,
    page_type: page.page_type ?? null,
    name: page.name,
    slug: page.slug,
    weight: page.weight ?? null,
    start: page.start ?? null,
    end: page.end ?? null,
    timezone: page.timezone ?? null,
    page_id: page.page_id ?? null,
    lect: page.lect ?? {},
  });
  return hmacBase64Url(key, material);
}

export function pageSignature(hash: string): string {
  return hash.slice(0, SIGNATURE_LENGTH);
}

export function hashIncludesSignature(hash: string, signature: string): boolean {
  return signature.length === SIGNATURE_LENGTH && hash.includes(signature);
}

// Credential the generated Apps Script sends with edit callbacks. It is
// derived from SHEET_WEBHOOK_SECRET but scoped to one spreadsheet, so it is
// safe to embed in a container-bound script that every sheet editor can read:
// leaking it only authorizes callbacks for that spreadsheet, and rotating
// SHEET_WEBHOOK_SECRET invalidates every issued token at once.
export async function callbackToken(webhookSecret: string, spreadsheetId: string): Promise<string> {
  return hmacBase64Url(webhookSecret, `callback:${spreadsheetId}`);
}

// JSON.stringify with object keys sorted at every depth, so key order in the
// CMS response can never flip the hash.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// Compares digests instead of the raw strings so the comparison time does not
// depend on how many leading characters match.
export async function secureEquals(actual: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [actualDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(actual)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const actualBytes = new Uint8Array(actualDigest);
  const expectedBytes = new Uint8Array(expectedDigest);
  let diff = 0;
  for (let index = 0; index < actualBytes.length; index += 1) {
    diff |= actualBytes[index] ^ expectedBytes[index];
  }
  return diff === 0;
}

async function hmacBase64Url(key: string, material: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(material));
  return base64UrlBytes(new Uint8Array(signature));
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
