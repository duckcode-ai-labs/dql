import { extractTablesFromSql } from '@duckcodeailabs/dql-core';

/**
 * Certification metadata a creator would otherwise type by hand when an answer
 * becomes a draft block. Everything here is derived from what the answer already
 * knows (its SQL or semantic fields, its result column names, its lineage). It
 * never reads or writes data values, and it never overrides a value the draft
 * already declares.
 */

export interface CertificationPrefillHints {
  /** The answer's SQL, used when the draft source has no `query` of its own. */
  sql?: string;
  /** Column names of the answer's result (names only, never rows). */
  columns?: string[];
  /** The creator the draft is assigned to. */
  owner?: string;
  /** Business entities known from the semantic layer for a semantic draft. */
  entities?: string[];
  /** Maps a table the SQL reads to its dbt model/source id, when lineage knows it. */
  sourceSystemFor?: (table: string) => string | undefined;
}

export interface CertificationSuggestion {
  field: string;
  value: string | string[];
}

export interface CertificationPrefill {
  source: string;
  /** Every value written, so the creator can review it. */
  suggested: CertificationSuggestion[];
  /** Fields the answer did not tell us enough to suggest. */
  unknown: string[];
}

const DEFAULT_PATTERN = 'custom';
const DEFAULT_REVIEW_CADENCE = 'quarterly';
const DEFAULT_TEST = 'assert row_count > 0';

export function prefillCertificationMetadata(source: string, hints: CertificationPrefillHints = {}): CertificationPrefill {
  const open = source.match(/\bblock\s+"[^"]+"\s*\{/i);
  if (!open || open.index === undefined) return { source, suggested: [], unknown: [] };

  const sql = (extractQuery(source) ?? hints.sql ?? '').trim();
  const metrics = [...readList(source, 'metrics'), ...readString(source, 'metric')];
  const dimensions = readList(source, 'dimensions');
  const tables = sql ? usedTables(sql) : [];

  const suggested: CertificationSuggestion[] = [];
  const unknown: string[] = [];
  const propose = (field: string, value: string | string[] | undefined) => {
    if (value === undefined || (Array.isArray(value) && value.length === 0) || value === '') {
      unknown.push(field);
      return;
    }
    suggested.push({ field, value });
  };

  if (!hasValue(source, 'pattern')) propose('pattern', DEFAULT_PATTERN);
  if (!hasValue(source, 'grain')) propose('grain', grainFor(sql, dimensions));
  if (!hasValue(source, 'outputs')) propose('outputs', unique(hints.columns?.length ? hints.columns : outputsFor(sql, dimensions, metrics)));
  if (!hasValue(source, 'reviewCadence')) propose('reviewCadence', DEFAULT_REVIEW_CADENCE);
  if (!hasValue(source, 'entities')) {
    propose('entities', unique(hints.entities?.length ? hints.entities : tables.map(lastSegment)));
  }
  if (!hasValue(source, 'sourceSystems')) {
    propose('sourceSystems', unique(tables.map((table) => hints.sourceSystemFor?.(table) ?? table)));
  }
  if (!/\btests\s*\{/i.test(source)) propose('tests', DEFAULT_TEST);
  if (hints.owner?.trim() && !hasValue(source, 'owner')) propose('owner', hints.owner.trim());

  if (suggested.length === 0) return { source, suggested, unknown };

  const fieldLines = suggested
    .filter((entry) => entry.field !== 'tests')
    .map((entry) => `  ${entry.field} = ${render(entry.value)}`);
  const marker = `  // Suggested by DQL from this answer. Review each value before you certify: ${suggested.map((entry) => entry.field).join(', ')}.`;

  let next = source;
  // A field the skeleton left empty (`owner = ""`) is filled in place so it appears once.
  for (const entry of suggested) {
    if (entry.field === 'tests') continue;
    const empty = new RegExp(`^([ \\t]*)${entry.field}[ \\t]*=[ \\t]*(?:""|\\[[ \\t]*\\])[ \\t]*$`, 'm');
    if (empty.test(next)) {
      next = next.replace(empty, `$1${entry.field} = ${render(entry.value)}`);
      const at = fieldLines.indexOf(`  ${entry.field} = ${render(entry.value)}`);
      if (at >= 0) fieldLines.splice(at, 1);
    }
  }
  const head = next.match(/\bblock\s+"[^"]+"\s*\{/i)!;
  const insertAt = (head.index ?? 0) + head[0].length;
  next = `${next.slice(0, insertAt)}\n${[marker, ...fieldLines].join('\n')}${next.slice(insertAt)}`;

  if (suggested.some((entry) => entry.field === 'tests')) {
    const close = next.lastIndexOf('}');
    if (close > 0) next = `${next.slice(0, close).trimEnd()}\n\n  tests {\n    ${DEFAULT_TEST}\n  }\n}${next.slice(close + 1)}`;
  }
  return { source: next, suggested, unknown };
}

function render(value: string | string[]): string {
  return Array.isArray(value) ? `[${value.map((item) => JSON.stringify(item)).join(', ')}]` : JSON.stringify(value);
}

function hasValue(source: string, key: string): boolean {
  if (new RegExp(`\\b${key}\\s*=\\s*"[^"]+"`, 'i').test(source)) return true;
  return new RegExp(`\\b${key}\\s*=\\s*\\[\\s*"`, 'i').test(source);
}

function readList(source: string, key: string): string[] {
  const match = source.match(new RegExp(`\\b${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'i'));
  return match ? (match[1].match(/"([^"]*)"/g) ?? []).map((item) => item.slice(1, -1)) : [];
}

function readString(source: string, key: string): string[] {
  const value = source.match(new RegExp(`\\b${key}\\s*=\\s*"([^"]+)"`, 'i'))?.[1];
  return value ? [value] : [];
}

function extractQuery(source: string): string | undefined {
  return source.match(/\bquery\s*=\s*"""([\s\S]*?)"""/i)?.[1];
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function lastSegment(table: string): string {
  return table.split('.').filter(Boolean).pop() ?? table;
}

function usedTables(sql: string): string[] {
  try {
    return unique(extractTablesFromSql(sql).tables.map((table) => table.replace(/^"|"$/g, '')));
  } catch {
    return [];
  }
}

function stripSql(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n\r]*/g, ' ');
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function selectOutputs(sql: string): string[] {
  const match = stripSql(sql).match(/\bselect\b([\s\S]+?)\bfrom\b/i);
  if (!match) return [];
  return splitTopLevel(match[1]).map((expression) =>
    (expression.match(/\bas\s+["`]?([A-Za-z_][A-Za-z0-9_$]*)["`]?\s*$/i)?.[1]
      ?? expression.match(/(?:^|\.)["`]?([A-Za-z_][A-Za-z0-9_$]*)["`]?\s*$/)?.[1]
      ?? ''));
}

function outputsFor(sql: string, dimensions: string[], metrics: string[]): string[] {
  return sql ? selectOutputs(sql).filter(Boolean) : [...dimensions, ...metrics];
}

/** "one row per <cols>" from the GROUP BY (or, for a semantic draft, its dimensions). */
function grainFor(sql: string, dimensions: string[]): string | undefined {
  const fields = sql ? groupByFields(sql) : dimensions;
  const clean = unique(fields);
  return clean.length > 0 ? `one row per ${clean.join(', ')}` : undefined;
}

function groupByFields(sql: string): string[] {
  const match = stripSql(sql).match(/\bgroup\s+by\b([\s\S]+?)(?:\border\s+by\b|\blimit\b|\bqualify\b|\bhaving\b|\bwindow\b|$)/i);
  if (!match) return [];
  const outputs = selectOutputs(sql);
  const fields = splitTopLevel(match[1]).map((item) => {
    const cleaned = item.replace(/["`]/g, '').trim();
    // GROUP BY 2 names the second SELECT column.
    if (/^\d+$/.test(cleaned)) return outputs[Number(cleaned) - 1] ?? '';
    return /^[A-Za-z_][A-Za-z0-9_$.]*$/.test(cleaned) ? lastSegment(cleaned) : '';
  });
  // An expression we cannot name would make a partial grain read as the whole grain.
  return fields.every(Boolean) ? fields : [];
}
