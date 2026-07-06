import type { CmsPage, SyncCriterion, SyncOperator, SyncOrder, SyncSort } from './types';

export function parseCriteria(form: FormData): SyncCriterion[] {
  const indexes = new Set<number>();
  for (const key of form.keys()) {
    const match = key.match(/^(?:search|path)(\d+)$/);
    if (match) indexes.add(Number(match[1]));
  }

  return [...indexes]
    .sort((left, right) => left - right)
    .map((index) => ({
      index,
      term: String(form.get(`search${index}`) ?? '').trim(),
      path: String(form.get(`path${index}`) ?? '').trim(),
    }))
    .filter((criterion) => criterion.term);
}

export function parseOperator(value: unknown): SyncOperator {
  const operator = String(value ?? '').toUpperCase();
  return operator === 'OR' || operator === 'NOT' ? operator : 'AND';
}

export function parseSort(value: unknown): SyncSort {
  const sort = String(value ?? '');
  return ['updated_at', 'created_at', 'name', 'weight', 'id'].includes(sort) ? sort as SyncSort : 'updated_at';
}

export function parseOrder(value: unknown): SyncOrder {
  return String(value ?? '').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
}

export function filterAndSortPages(
  pages: CmsPage[],
  criteria: SyncCriterion[],
  operator: SyncOperator,
  sort: SyncSort,
  order: SyncOrder,
): CmsPage[] {
  const filtered = criteria.length ? pages.filter((page) => matchesCriteria(page, criteria, operator)) : pages;
  return [...filtered].sort((left, right) => comparePages(left, right, sort, order));
}

function matchesCriteria(page: CmsPage, criteria: SyncCriterion[], operator: SyncOperator): boolean {
  if (operator === 'OR') return criteria.some((criterion) => matchesCriterion(page, criterion));
  if (operator === 'NOT') {
    const [base, ...excluded] = criteria;
    return (!base || matchesCriterion(page, base)) && !excluded.some((criterion) => matchesCriterion(page, criterion));
  }
  return criteria.every((criterion) => matchesCriterion(page, criterion));
}

function matchesCriterion(page: CmsPage, criterion: SyncCriterion): boolean {
  const needle = normalize(criterion.term);
  if (!needle) return true;
  const haystacks = criterion.path
    ? valuesAtPath(page.lect ?? {}, criterion.path)
    : [page.name, page.slug, JSON.stringify(page.lect ?? {})];
  return haystacks.some((value) => normalize(stringifySearchValue(value)).includes(needle));
}

function valuesAtPath(source: unknown, path: string): unknown[] {
  const parts = path.split('.').filter(Boolean);
  return walkPath([source], parts);
}

function walkPath(values: unknown[], parts: string[]): unknown[] {
  if (!parts.length) return values;
  const [head, ...tail] = parts;
  const match = head.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\[\*\])?$/);
  if (!match) return [];
  const key = match[1];
  const wildcard = head.endsWith('[*]');
  const next: unknown[] = [];

  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    const entry = (value as Record<string, unknown>)[key];
    if (wildcard) {
      if (Array.isArray(entry)) next.push(...entry);
    } else {
      next.push(entry);
    }
  }

  return walkPath(next, tail);
}

function comparePages(left: CmsPage, right: CmsPage, sort: SyncSort, order: SyncOrder): number {
  const direction = order === 'ASC' ? 1 : -1;
  const result = compareValue(sortValue(left, sort), sortValue(right, sort)) || compareValue(left.id, right.id);
  return result * direction;
}

function sortValue(page: CmsPage, sort: SyncSort): string | number {
  if (sort === 'id' || sort === 'weight') return Number(page[sort] ?? 0);
  return String(page[sort] ?? '');
}

function compareValue(left: string | number, right: string | number): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right));
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function stringifySearchValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
