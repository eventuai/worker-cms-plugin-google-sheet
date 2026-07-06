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
  SHEET_WEBHOOK_SECRET?: string;
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
  version_action?: string;
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
  pluginHost: string;
  limit: number;
  criteria: SyncCriterion[];
  operator: SyncOperator;
  sort: SyncSort;
  order: SyncOrder;
  selectedColumns?: Record<string, string[]>;
}

export type SyncOperator = 'AND' | 'OR' | 'NOT';
export type SyncSort = 'updated_at' | 'created_at' | 'name' | 'weight' | 'id';
export type SyncOrder = 'ASC' | 'DESC';

export interface SyncCriterion {
  index: number;
  term: string;
  path: string;
}

export interface SyncResult {
  spreadsheetId: string;
  spreadsheetUrl: string;
  pageTypes: Array<{ pageType: string; total: number; exported: number; columns: number }>;
}

export interface SyncPreviewResult {
  pageTypes: Array<{ pageType: string; total: number; exported: number; columns: string[] }>;
}

export interface ImportResult {
  spreadsheetId: string;
  spreadsheetUrl: string;
  pageTypes: Array<{ pageType: string; rows: number; updated: number; skipped: number; errors: string[] }>;
  ok: boolean;
}

// Notification-only payload from the Apps Script edit trigger. Row content is
// deliberately absent from this contract - the plugin re-reads the sheet.
export interface SheetCallbackPayload {
  spreadsheetId?: unknown;
  pageTypes?: unknown;
  pageType?: unknown;
  sheetName?: unknown;
  language?: unknown;
}
