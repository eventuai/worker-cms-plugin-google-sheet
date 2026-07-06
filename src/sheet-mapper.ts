import { HASH_COLUMN } from './integrity';
import type { CmsPage, CmsPageInput } from './types';

const BASE_COLUMNS = ['id', 'page_type', 'name', 'slug', 'weight', 'start', 'end', 'timezone', 'page_id', 'updated_at'];
const READONLY_COLUMNS = new Set(['updated_at', HASH_COLUMN]);

type FlatLect = Record<string, string>;

export function sheetColumnsForPages(pages: CmsPage[], language: string): string[] {
  const rows = pages.map((page) => pageToRow(page, language));
  return columnsForRows(rows);
}

// `hashes` must align with `pages`; when provided, a trailing _hash column is
// added so imports can verify each row against the current CMS state.
export function pagesToSheetValues(pages: CmsPage[], language: string, selectedColumns?: string[], hashes?: string[]): string[][] {
  const rows = pages.map((page) => pageToRow(page, language));
  const allColumns = columnsForRows(rows);
  const columns = selectedSheetColumns(allColumns, selectedColumns);
  if (!hashes) return [columns, ...rows.map((row) => columns.map((column) => row[column] ?? ''))];
  return [
    [...columns, HASH_COLUMN],
    ...rows.map((row, index) => [...columns.map((column) => row[column] ?? ''), hashes[index] ?? '']),
  ];
}

function columnsForRows(rows: Array<Record<string, string>>): string[] {
  const columns = [...BASE_COLUMNS];
  const seen = new Set(columns);
  for (const row of rows) {
    for (const column of Object.keys(row)) {
      if (!seen.has(column)) {
        seen.add(column);
        columns.push(column);
      }
    }
  }
  return columns;
}

function selectedSheetColumns(allColumns: string[], selectedColumns: string[] | undefined): string[] {
  if (!selectedColumns) return allColumns;
  const allowed = new Set(allColumns);
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const column of ['id', ...selectedColumns]) {
    if (!allowed.has(column) || seen.has(column)) continue;
    seen.add(column);
    columns.push(column);
  }
  return columns.length ? columns : ['id'];
}

export interface SheetRow {
  rowNumber: number;
  cells: string[];
}

export interface RowUpdate {
  rowNumber: number;
  id: number | null;
  input: CmsPageInput;
  hash: string | null;
  error?: string;
}

// Maps a full sheet matrix (header row + contiguous data rows starting at
// sheet row 2) to per-row updates. Used by the admin "Import from Sheet"
// action, which imports the entire sheet.
export function sheetValuesToUpdates(values: string[][], pageType: string, language: string): RowUpdate[] {
  const [headerRow, ...dataRows] = values;
  if (!headerRow?.length) return [];
  const rows = dataRows.map((cells, index) => ({ rowNumber: index + 2, cells }));
  return sheetRowsToUpdates(headerRow, rows, pageType, language);
}

// Maps specific numbered rows to updates. Used by the edit-trigger callback,
// which re-reads only the rows the Apps Script reported as changed. Each
// update keeps its absolute sheet row number so error messages and _hash
// renewals target the right cell even when the rows are non-contiguous.
export function sheetRowsToUpdates(headerRow: string[], rows: SheetRow[], pageType: string, language: string): RowUpdate[] {
  if (!headerRow?.length) return [];
  const headers = headerRow.map((value) => value.trim());
  return rows
    .filter((row) => row.cells.some((cell) => String(cell ?? '').trim() !== ''))
    .map((row) => ({ rowNumber: row.rowNumber, ...buildRowUpdate(headers, row.cells, pageType, language) }));
}

function buildRowUpdate(headers: string[], cells: string[], pageType: string, language: string): Omit<RowUpdate, 'rowNumber'> {
  const record: Record<string, string> = {};
  headers.forEach((header, index) => {
    if (header) record[header] = String(cells[index] ?? '');
  });

  const hash = record[HASH_COLUMN]?.trim() || null;
  const id = parseId(record.id);
  if (id === null) return { id, input: {}, hash, error: 'missing_or_invalid_id' };

  const lectColumns: FlatLect = {};
  for (const [key, value] of Object.entries(record)) {
    if (BASE_COLUMNS.includes(key) || READONLY_COLUMNS.has(key)) continue;
    if (isLectColumn(key)) lectColumns[key] = value;
  }

  const input: CmsPageInput = {
    // The sheet tab decides the page type; a page_type cell in the row is
    // ignored so an edited cell cannot retype (or hijack) another page.
    page_type: pageType,
    name: record.name || undefined,
    slug: record.slug || undefined,
    weight: parseOptionalNumber(record.weight),
    start: nullable(record.start),
    end: nullable(record.end),
    timezone: nullable(record.timezone),
    page_id: parseOptionalNumber(record.page_id),
    lect: unflattenLect(lectColumns, language),
  };
  return { id, input: pruneUndefined(input), hash };
}

function pageToRow(page: CmsPage, language: string): Record<string, string> {
  return {
    id: String(page.id),
    page_type: page.page_type ?? '',
    name: page.name,
    slug: page.slug,
    weight: String(page.weight ?? ''),
    start: page.start ?? '',
    end: page.end ?? '',
    timezone: page.timezone ?? '',
    page_id: page.page_id == null ? '' : String(page.page_id),
    updated_at: page.updated_at ?? '',
    ...flattenLect(page.lect ?? {}, language),
  };
}

export function flattenLect(lect: Record<string, unknown>, language: string): FlatLect {
  const out: FlatLect = {};
  flattenObject(lect, '', out, language);
  return out;
}

function flattenObject(
  value: Record<string, unknown>,
  prefix: string,
  out: FlatLect,
  language: string,
  opts: { includePrivate?: boolean } = {},
): void {
  for (const [key, entry] of Object.entries(value)) {
    if (key === '_pointers') {
      if (isPlainObject(entry)) {
        for (const [pointerKey, pointerValue] of Object.entries(entry)) {
          out[`${prefix}*${pointerKey}`] = scalarToCell(pointerValue);
        }
      }
      continue;
    }

    if (key === '_blocks') {
      if (Array.isArray(entry)) {
        entry.forEach((block, index) => {
          if (isPlainObject(block)) {
            flattenObject(block, `${prefix}@_blocks[${index}]`, out, language, { includePrivate: true });
          }
        });
      } else {
        out[`${prefix}@_blocks_json`] = JSON.stringify(entry ?? []);
      }
      continue;
    }

    if (key === '_tags') {
      out[`${prefix}@${key}_json`] = JSON.stringify(entry ?? []);
      continue;
    }

    if (key.startsWith('_') && !opts.includePrivate) continue;

    if (Array.isArray(entry)) {
      entry.forEach((item, index) => {
        if (isPlainObject(item)) flattenObject(item, `${prefix}.${key}[${index}]`, out, language);
        else out[`${prefix}.${key}[${index}]@value`] = scalarToCell(item);
      });
      continue;
    }

    if (isLocalizedMap(entry)) {
      for (const [lang, localizedValue] of Object.entries(entry)) {
        out[`${prefix}.${key}|${lang}`] = scalarToCell(localizedValue);
      }
      if (!Object.keys(entry).length) out[`${prefix}.${key}|${language}`] = '';
      continue;
    }

    if (isPlainObject(entry)) {
      out[`${prefix}@${key}_json`] = JSON.stringify(entry);
      continue;
    }

    out[`${prefix}@${key}`] = scalarToCell(entry);
  }
}

export function unflattenLect(flat: FlatLect, language: string): Record<string, unknown> {
  const lect: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(flat)) {
    if (!isLectColumn(name)) continue;
    if (applyBlockField(lect, name, raw, language)) continue;
    applyField(lect, name, raw, language);
  }
  return lect;
}

function applyBlockField(lect: Record<string, unknown>, name: string, raw: string, language: string): boolean {
  const match = name.match(/^@_blocks\[(\d+)](.+)$/);
  if (!match) return false;
  const index = Number(match[1]);
  const rest = match[2];
  if (!rest || !Number.isInteger(index) || index < 0) return true;

  const blocks = Array.isArray(lect._blocks) ? lect._blocks as Record<string, unknown>[] : [];
  lect._blocks = blocks;
  blocks[index] = isPlainObject(blocks[index]) ? blocks[index] : {};
  applyField(blocks[index], rest, raw, language);
  return true;
}

function applyField(lect: Record<string, unknown>, name: string, raw: string, language: string): void {
  const segments = name.match(/(?:^\.[a-zA-Z0-9_]+\[\d+])|(?:\.[a-zA-Z0-9_]+\[\d+])|(?:[@*.][^.*@]+)/g);
  if (!segments?.length) return;

  let current = lect;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const itemMatch = segment.match(/^\.([a-zA-Z0-9_]+)\[(\d+)]$/);
    if (itemMatch) {
      const key = itemMatch[1];
      const itemIndex = Number(itemMatch[2]);
      const list = Array.isArray(current[key]) ? current[key] as Record<string, unknown>[] : [];
      current[key] = list;
      list[itemIndex] = isPlainObject(list[itemIndex]) ? list[itemIndex] : {};
      current = list[itemIndex];
      continue;
    }

    if (segment.startsWith('@')) {
      const key = segment.slice(1);
      if (key === '_blocks_json') current._blocks = parseJsonCell(raw, []);
      else if (key === '_tags_json') current._tags = parseJsonCell(raw, []);
      else if (key.endsWith('_json')) current[key.slice(0, -5)] = parseJsonCell(raw, {});
      else current[key] = raw;
      continue;
    }

    if (segment.startsWith('*')) {
      const key = segment.slice(1);
      const pointers = isPlainObject(current._pointers) ? current._pointers as Record<string, unknown> : {};
      current._pointers = pointers;
      pointers[key] = raw;
      continue;
    }

    if (segment.startsWith('.')) {
      const field = segment.slice(1);
      const [key, lang = language] = field.split('|');
      const map = isPlainObject(current[key]) && !Array.isArray(current[key]) ? current[key] as Record<string, unknown> : {};
      current[key] = map;
      map[lang || language] = raw;
    }
  }
}

function isLectColumn(name: string): boolean {
  return name.startsWith('@') || name.startsWith('*') || name.startsWith('.');
}

function isLocalizedMap(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (!keys.length) return false;
  return keys.every((key) => isLanguageKey(key) && isScalar(value[key]));
}

function isLanguageKey(key: string): boolean {
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isScalar(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function scalarToCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function parseJsonCell(value: string, fallback: unknown): unknown {
  if (!value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseId(value: string | undefined): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function nullable(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value.trim() === '' ? null : value;
}

function pruneUndefined<T extends object>(value: T): T {
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) delete record[key];
  }
  return value;
}
