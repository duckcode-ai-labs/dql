/**
 * Edit-an-existing-block (spec 17, part A).
 *
 * The create path always writes a NEW deduped draft. Users also need to MODIFY
 * one specific block — add a missed table/column, change the grain — and have it
 * update the SAME file. `editBlock` loads the block at `blockPath`, asks the
 * model for the UPDATED block applying the user's change, re-grounds/validates
 * the SQL via spec-15, and writes the result BACK to the same path. It NEVER
 * forks a new draft.
 *
 * Locked principle (AI drafts, humans certify): the block's status is preserved.
 * A draft stays `draft`; an already-certified block stays `certified` (the human
 * must re-certify after an edit). We never silently downgrade or auto-certify.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Parser } from '@zlens/core';

/** Block metadata + SQL loaded from an existing `.dql` file. */
export interface LoadedBlock {
  /** Absolute path on disk. */
  absPath: string;
  /** Path exactly as supplied by the caller (project-relative or absolute). */
  requestedPath: string;
  name: string;
  blockType: 'semantic' | 'custom';
  domain?: string;
  owner?: string;
  status?: string;
  description?: string;
  grain?: string;
  pattern?: string;
  entities?: string[];
  outputs?: string[];
  tags?: string[];
  llmContext?: string;
  invariants?: string[];
  sourceSystems?: string[];
  /** The block's current SQL body (raw, with `{{ ref() }}` intact). */
  sql: string;
  /** The full original file text (so non-modeled content can be preserved). */
  rawFile: string;
}

function resolveAbs(projectRoot: string, blockPath: string): string {
  return isAbsolute(blockPath) ? blockPath : join(projectRoot, blockPath);
}

/** Parse the existing block file into its SQL + governance metadata. */
export function loadBlockForEdit(projectRoot: string, blockPath: string): LoadedBlock {
  const absPath = resolveAbs(projectRoot, blockPath);
  if (!existsSync(absPath)) {
    throw new Error(`Block file not found for edit: ${blockPath}`);
  }
  const rawFile = readFileSync(absPath, 'utf-8');
  const ast = new Parser(rawFile, blockPath).parse();
  const block = ast.statements.find((stmt) => (stmt as { kind?: string }).kind === 'BlockDecl') as
    | Record<string, unknown>
    | undefined;
  if (!block) {
    throw new Error(`No block declaration found in ${blockPath}`);
  }
  const asStr = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined;
  const asArr = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
  const query = block.query as { rawSQL?: string } | undefined;

  return {
    absPath,
    requestedPath: blockPath,
    name: asStr(block.name) ?? 'block',
    blockType: block.blockType === 'semantic' ? 'semantic' : 'custom',
    domain: asStr(block.domain),
    owner: asStr(block.owner),
    status: asStr(block.status),
    description: asStr(block.description),
    grain: asStr(block.grain),
    pattern: asStr(block.pattern),
    entities: asArr(block.entities),
    outputs: asArr(block.outputs),
    tags: asArr(block.tags),
    llmContext: asStr(block.llmContext),
    invariants: asArr(block.invariants),
    sourceSystems: asArr(block.sourceSystems),
    sql: (query?.rawSQL ?? '').trim(),
    rawFile,
  };
}

/**
 * The status the edited block should carry (spec 17, part A locked principle).
 * Certified stays certified (human must re-certify); everything else stays as-is
 * or defaults to `draft`. We never auto-certify and never downgrade.
 */
export function resolveEditedStatus(original?: string): string {
  const status = (original ?? '').trim().toLowerCase();
  if (status === 'certified') return 'certified';
  if (status) return status;
  return 'draft';
}

export interface EditedBlockFields {
  name: string;
  blockType: 'semantic' | 'custom';
  status: string;
  domain?: string;
  owner?: string;
  description?: string;
  grain?: string;
  pattern?: string;
  entities?: string[];
  outputs?: string[];
  tags?: string[];
  llmContext?: string;
  invariants?: string[];
  sourceSystems?: string[];
  sql: string;
}

function escapeString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function stringArrayLine(name: string, values: string[] | undefined): string {
  if (!values || values.length === 0) return '';
  return `\n  ${name} = [${values.map((v) => `"${escapeString(v)}"`).join(', ')}]`;
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? pad + line : line))
    .join('\n');
}

/**
 * Render the edited block back to canonical DQL text. Preserves name, owner,
 * domain, grain, and status; updates the SQL + any modeled metadata. A small
 * header notes the in-place edit (no review verdict is asserted — the human
 * re-certifies).
 */
export function renderEditedBlock(fields: EditedBlockFields): string {
  const lines: string[] = [`block "${escapeString(fields.name)}" {`];
  lines.push(`  type = "${fields.blockType}"`);
  if (fields.domain) lines.push(`  domain = "${escapeString(fields.domain)}"`);
  lines.push(`  status = "${escapeString(fields.status)}"`);
  if (fields.description) lines.push(`  description = "${escapeString(fields.description)}"`);
  if (fields.owner) lines.push(`  owner = "${escapeString(fields.owner)}"`);
  if (fields.pattern) lines.push(`  pattern = "${escapeString(fields.pattern)}"`);
  if (fields.grain) lines.push(`  grain = "${escapeString(fields.grain)}"`);
  const arrays = [
    stringArrayLine('entities', fields.entities),
    stringArrayLine('outputs', fields.outputs),
    stringArrayLine('sourceSystems', fields.sourceSystems),
    stringArrayLine('tags', fields.tags),
    stringArrayLine('invariants', fields.invariants),
  ].join('');
  if (fields.llmContext) lines.push(`  llmContext = "${escapeString(fields.llmContext)}"`);

  const body = [
    '// dql-format: 1',
    `// Updated in place by AI build (edit mode). status preserved as "${fields.status}".`,
    `// AI drafts, humans certify — review the change${
      fields.status === 'certified' ? ', then re-certify this block.' : '.'
    }`,
    lines.join('\n') + arrays,
    '',
    '  query = """',
    indent(fields.sql, 4),
    '  """',
    '}',
    '',
  ];
  return body.join('\n');
}

/** Write the edited block back to its original path. Returns the path written. */
export function writeEditedBlock(absPath: string, content: string): string {
  writeFileSync(absPath, content, 'utf-8');
  return absPath;
}
