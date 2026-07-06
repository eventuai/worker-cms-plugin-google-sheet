export interface PluginEnv {
  PLUGIN_SECRET?: string;
  CMS_URL?: string;
  SYNC_PAGE_TYPES?: string;
  DEFAULT_LANGUAGE?: string;
  GOOGLE_ACCESS_TOKEN?: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL?: string;
  GOOGLE_PRIVATE_KEY?: string;
  GOOGLE_PRIVATE_KEY_ID?: string;
  GOOGLE_IMPERSONATE_EMAIL?: string;
}

export interface CmsPage {
  id: number;
  uuid?: string;
  page_type: string | null;
  name: string;
  slug: string;
  weight: number;
  start: string | null;
  end: string | null;
  timezone: string | null;
  page_id: number | null;
  created_at?: string;
  updated_at?: string;
  lect: Record<string, unknown>;
  tags?: number[];
}

export interface CmsPageInput {
  page_type?: string;
  name?: string;
  slug?: string;
  weight?: number;
  start?: string | null;
  end?: string | null;
  timezone?: string | null;
  page_id?: number | null;
  lect?: Record<string, unknown>;
}

export interface CmsUser {
  id?: string;
  email?: string;
  name?: string;
  role?: string;
  permissions?: string[];
}

export interface SyncRequest {
  spreadsheetId: string;
  pageTypes: string[];
  language: string;
  limit: number;
}

export interface SyncResult {
  spreadsheetId: string;
  spreadsheetUrl: string;
  pageTypes: Array<{ pageType: string; count: number; columns: number }>;
}

export interface ImportResult {
  spreadsheetId: string;
  spreadsheetUrl: string;
  pageTypes: Array<{ pageType: string; rows: number; updated: number; skipped: number; errors: string[] }>;
}
