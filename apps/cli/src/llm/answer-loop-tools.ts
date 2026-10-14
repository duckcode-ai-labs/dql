import {
  dqlToolNamesForSurface,
  expandGroundingFromCatalog,
  openMetadataCatalog,
  redactProviderResultRows,
  markProviderMetadata,
  markProviderMetadataArray,
  type AgentToolDefinition,
  type GroundingExpansionResult,
} from "@zlens/agent";
import { DQLContext } from "@zlens/mcp";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { join, relative } from "node:path";
import { buildAgentTools } from "./tools.js";
import { QueryExecutor } from "@zlens/connectors";
import { NotebookDatasetWorkspace } from "../notebook-datasets.js";

/**
 * A bounded, equality-predicated lookup of NAMED relations against the live
 * warehouse. Supplied by the host, which owns the connection and the activated
 * metadata scope.
 */
export type LiveRelationProbe = (
  relations: string[],
) => Promise<GroundingExpansionResult | undefined>;

export function createGroundingContextExpander(projectRoot: string, liveProbe?: LiveRelationProbe) {
  return async (request: Parameters<typeof expandGroundingFromCatalog>[1]) => {
    const catalog = openMetadataCatalog(projectRoot);
    let fromCatalog: GroundingExpansionResult | undefined;
    try {
      fromCatalog = expandGroundingFromCatalog(catalog, request);
    } finally {
      catalog.close();
    }
    if (fromCatalog) return fromCatalog;

    // The catalog does not know this relation. That is NOT proof it does not
    // exist: `getSchemaContextForAgent` deliberately returns nothing on a
    // lexical miss, so a real table the notebook queries happily is reported as
    // "outside the inspected metadata context" without the warehouse ever being
    // asked. A targeted lookup of named relations is not the unbounded rescan
    // that policy exists to prevent, so try it before refusing.
    if (!liveProbe) return undefined;
    if (request.code !== 'unknown_relation' && request.code !== 'unknown_column') return undefined;
    const named = (request.offending?.relations?.length
      ? request.offending.relations
      : request.offending?.relation
        ? [request.offending.relation]
        : []
    ).filter((relation): relation is string => Boolean(relation?.trim())).slice(0, 4);
    if (named.length === 0) return undefined;
    try {
      return await liveProbe(named);
    } catch {
      // A probe failure must never turn a refusal into a crash.
      return undefined;
    }
  };
}

export function buildAnswerLoopTools(
  projectRoot: string,
  options: { researchResultRowsOptIn?: boolean } = {},
): AgentToolDefinition[] {
  const ctx = new DQLContext({ projectRoot });
  const allowed = new Set<string>(dqlToolNamesForSurface("answer_loop"));
  const catalogTools = buildAgentTools(ctx).filter((tool) =>
    allowed.has(tool.name),
  );
  return [
    ...catalogTools.map((tool) => ({
      ...tool,
      run: async (args: unknown) => {
        const output = await tool.run(args);
        return output && typeof output === 'object' ? markProviderMetadata(output as object) : output;
      },
    })),
    projectSourceSearchTool(projectRoot),
    ...notebookDatasetTools(projectRoot, options.researchResultRowsOptIn === true),
  ];
}

function notebookDatasetTools(projectRoot: string, resultRowsOptIn: boolean): AgentToolDefinition[] {
  const executor = new QueryExecutor();
  const workspace = new NotebookDatasetWorkspace(projectRoot, executor, [
    join(projectRoot, ".dql", "connectors"),
    projectRoot,
  ]);
  const datasetByInput = (args: unknown) => {
    const input = objectArgs(args);
    const value =
      typeof input.id === "string"
        ? input.id
        : typeof input.name === "string"
          ? input.name
          : "";
    return workspace
      .list()
      .find(
        (dataset) =>
          dataset.id === value ||
          dataset.alias.toLowerCase() === value.toLowerCase() ||
          dataset.name.toLowerCase() === value.toLowerCase(),
      );
  };
  return [
    {
      name: "list_notebook_datasets",
      description:
        "List imported and staged notebook datasets using metadata only. Use before proposing local or mixed-source analysis. Never returns complete file contents.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      run: async () => ({
        datasets: markProviderMetadataArray(workspace.list().map((dataset) => ({
          id: dataset.id,
          name: dataset.name,
          alias: dataset.alias,
          storageMode: dataset.storageMode,
          trustState: dataset.trustState,
          rowCount: dataset.profile.rowCount,
          refreshedAt: dataset.refreshedAt,
          columns: dataset.profile.columns.map((column) => ({
            name: column.name,
            type: column.type,
            flags: column.flags,
          })),
          lineage: dataset.lineage,
        }))),
      }),
    },
    {
      name: "describe_notebook_dataset",
      description:
        "Describe one local/project/staged notebook dataset including schema, bounded profile, freshness, lineage, and trust. Does not return raw rows.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: { id: { type: "string" } },
      },
      run: async (args: unknown) => {
        const dataset = datasetByInput(args);
        if (!dataset) return { found: false, error: "Dataset not found." };
        return markProviderMetadata({
          found: true,
          dataset: {
            ...dataset,
            profile: {
              ...dataset.profile,
              preview: undefined,
              columns: dataset.profile.columns.map((column) => ({
                ...column,
                sampleValues: undefined,
              })),
            },
          },
        });
      },
    },
    {
      name: "sample_notebook_dataset",
      description:
        "Return a strictly bounded, redacted sample from a notebook dataset. Use only when schema/profile is insufficient. Sensitive columns are always redacted.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: { type: "string" },
          limit: { type: "number", minimum: 1, maximum: 20 },
        },
      },
      run: async (args: unknown) => {
        const dataset = datasetByInput(args);
        if (!dataset) return { found: false, error: "Dataset not found." };
        const input = objectArgs(args);
        const limit =
          typeof input.limit === "number"
            ? Math.max(1, Math.min(20, Math.floor(input.limit)))
            : 5;
        const sensitive = new Set(
          dataset.profile.columns
            .filter((column) => column.flags?.includes("sensitive"))
            .map((column) => column.name),
        );
        return {
          found: true,
          dataset: dataset.alias,
          rows: redactProviderResultRows(
            dataset.profile.preview.map((row) => Object.fromEntries(
              Object.entries(row).map(([key, value]) => [key, sensitive.has(key) ? '[REDACTED]' : value]),
            )),
            limit,
          ),
          sampledRows: Math.min(limit, dataset.profile.preview.length),
          totalRows: dataset.profile.rowCount,
          warning:
            "Bounded preview only. Never infer population aggregates from these rows.",
        };
      },
    },
    {
      name: "propose_cross_source_join",
      description:
        "Compare dataset schemas and propose join keys/cardinality warnings. If multiple plausible keys or a many-to-many risk exists, returns clarificationRequired=true instead of guessing.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["left", "right"],
        properties: { left: { type: "string" }, right: { type: "string" } },
      },
      run: async (args: unknown) => {
        const input = objectArgs(args);
        const all = workspace.list();
        const find = (value: unknown) =>
          all.find(
            (dataset) =>
              dataset.id === value ||
              dataset.alias === value ||
              dataset.name === value,
          );
        const left = find(input.left);
        const right = find(input.right);
        if (!left || !right)
          return {
            found: false,
            error: "Both datasets must exist in the notebook workspace.",
          };
        const rightColumns = new Set(
          right.profile.columns.map((column) => column.name.toLowerCase()),
        );
        const candidates = left.profile.columns.filter(
          (column) =>
            rightColumns.has(column.name.toLowerCase()) &&
            /(^id$|_id$|^key$|_key$)/i.test(column.name),
        );
        const manyRisk = candidates.some((candidate) => {
          const other = right.profile.columns.find(
            (column) =>
              column.name.toLowerCase() === candidate.name.toLowerCase(),
          );
          return (
            (candidate.distinctCount ?? 0) < left.profile.sampledRows ||
            (other?.distinctCount ?? 0) < right.profile.sampledRows
          );
        });
        return {
          found: true,
          left: left.alias,
          right: right.alias,
          candidates: markProviderMetadataArray(candidates.map((column) => column.name)),
          manyToManyRisk: manyRisk,
          clarificationRequired: candidates.length !== 1 || manyRisk,
          recommendation:
            candidates.length === 1 && !manyRisk
              ? `Join on ${candidates[0].name} after confirming business grain.`
              : "Ask the user to confirm join key and expected cardinality.",
          freshnessMismatch: {
            left: left.refreshedAt,
            right: right.refreshedAt,
          },
          trustLabel: "review_required",
        };
      },
    },
    {
      name: "execute_local_analysis",
      description:
        "Execute bounded read-only SQL in the notebook DuckDB workspace over imported or staged datasets. Results are always review-required and never certified.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["sql"],
        properties: { sql: { type: "string" } },
      },
      run: async (args: unknown) => {
        const input = objectArgs(args);
        const sql =
          typeof input.sql === "string"
            ? input.sql.trim().replace(/;\s*$/, "")
            : "";
        if (
          !/^(select|with)\b/i.test(sql) ||
          /\b(insert|update|delete|drop|alter|create|copy|attach|install|load|pragma)\b/i.test(
            sql,
          )
        ) {
          return {
            error:
              "Local analysis only supports one read-only SELECT or WITH statement.",
          };
        }
        await workspace.initialize();
        const result = await executor.executeQuery(
          `SELECT * FROM (${sql}) AS dql_local_analysis LIMIT 200`,
          [],
          {},
          workspace.localConnection,
        );
        const normalizedRows = result.rows.slice(0, 200).map((row) => {
          if (row && typeof row === 'object' && !Array.isArray(row)) return row as Record<string, unknown>;
          if (Array.isArray(row)) return Object.fromEntries(result.columns.map((column, index) => [String(column), row[index]]));
          return { value: row };
        });
        return {
          trust: "review_required",
          source: "notebook_local_workspace",
          columns: markProviderMetadataArray(result.columns),
          rows: redactProviderResultRows(normalizedRows, 200),
          rowCount: result.rows.length,
          warning: "Mixed or local analysis cannot be certified automatically.",
        };
      },
    },
  ].filter((tool) => resultRowsOptIn || (tool.name !== 'sample_notebook_dataset' && tool.name !== 'execute_local_analysis'));
}

function projectSourceSearchTool(projectRoot: string): AgentToolDefinition {
  return {
    name: 'search_project_files',
    description:
      'Fast bounded ripgrep over the live DQL/dbt source tree. Use only when catalog and semantic search missed a likely block, metric, dimension, model, or join definition. Returns source paths and matching lines; it never executes or mutates files.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Business terms or identifiers to find in DQL, SQL, YAML, JSON, and Markdown sources.' },
        limit: { type: 'number', description: 'Maximum matching lines. Default 40, maximum 100.' },
      },
    },
    run: async (args) => {
      const input = objectArgs(args);
      const query = typeof input.query === 'string' ? input.query : '';
      const limit = typeof input.limit === 'number' ? Math.max(1, Math.min(100, Math.floor(input.limit))) : 40;
      const terms = sourceSearchTerms(query);
      if (terms.length === 0) return { query, matches: markProviderMetadataArray([]), note: 'No distinctive search terms.' };
      const pattern = terms.map(escapeRegex).join('|');
      const lines = await runRipgrep(projectRoot, pattern, limit);
      return {
        query,
        terms: markProviderMetadataArray(terms),
        matches: markProviderMetadataArray(lines.map((line) => ({
          path: line.path.startsWith('.')
            ? line.path.replace(/^\.\//, '')
            : relative(projectRoot, line.path) || line.path,
          line: line.line,
          text: line.text,
        }))),
      };
    },
  };
}

const SOURCE_SEARCH_STOPWORDS = new Set([
  'what', 'which', 'where', 'show', 'give', 'from', 'with', 'that', 'this', 'have',
  'does', 'the', 'and', 'for', 'our', 'their', 'metric', 'metrics', 'data', 'answer',
]);

function sourceSearchTerms(query: string): string[] {
  return Array.from(new Set((query.toLowerCase().match(/[a-z0-9_]+/g) ?? [])
    .filter((term) => term.length > 2 && !SOURCE_SEARCH_STOPWORDS.has(term))))
    .slice(0, 8);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function runRipgrep(
  projectRoot: string,
  pattern: string,
  limit: number,
): Promise<Array<{ path: string; line: number; text: string }>> {
  const args = [
    '--line-number', '--no-heading', '--color', 'never', '--ignore-case', '--max-count', '5',
    '--glob', '*.{dql,sql,yml,yaml,json,md}',
    '--glob', '!.git/**', '--glob', '!node_modules/**', '--glob', '!dist/**', '--glob', '!target/**',
    // `.dql` contains provider/connection settings and other runtime-local state.
    // Source repair must never make those files available to a model, even when
    // a user question happens to contain a word such as "api" or "token".
    '--glob', '!.dql/**',
    '--glob', '!**/.env*', '--glob', '!**/profiles.yml', '--glob', '!**/profiles.yaml',
    '--glob', '!**/*credential*.json', '--glob', '!**/*secret*.json', '--glob', '!**/*provider-settings*.json',
    pattern, '.',
  ];
  return new Promise((resolveSearch) => {
    const child = spawn('rg', args, { cwd: projectRoot, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    let settled = false;
    const finish = (value: Array<{ path: string; line: number; text: string }>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveSearch(value);
    };
    // This is a safety ceiling, not an interaction target: normal searches
    // finish in milliseconds. Give a CI-loaded machine enough time to start
    // rg so a real semantic definition is not incorrectly reported missing.
    const timer = setTimeout(() => {
      child.kill();
      finish([]);
    }, 4_000);
    child.stdout.on('data', (chunk: Buffer) => {
      if (output.length < 512_000) output += chunk.toString('utf8');
      else child.kill();
    });
    // Some minimal hosted and container runtimes do not ship ripgrep. The
    // governed answer flow must still find semantic definitions rather than
    // silently falling through to generated SQL.
    child.on('error', () => finish(runNativeSourceSearch(projectRoot, pattern, limit)));
    child.on('close', () => {
      const matches = output.split(/\r?\n/).flatMap((raw) => {
        const match = raw.match(/^(.*?):(\d+):(.*)$/);
        return match ? [{ path: match[1], line: Number(match[2]), text: redactSourceSearchLine(match[3]) }] : [];
      }).slice(0, limit);
      finish(matches);
    });
  });
}

const SOURCE_FILE_PATTERN = /\.(dql|sql|yml|yaml|json|md)$/i;
const SOURCE_SEARCH_IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'target', '.dql']);
const SOURCE_SEARCH_DENIED_FILE = /(?:^|\/)(?:\.env(?:\..*)?|profiles\.ya?ml|[^/]*(?:credential|secret|provider-settings)[^/]*\.(?:json|ya?ml))$/i;

function redactSourceSearchLine(value: string): string {
  return value
    .trim()
    .slice(0, 500)
    .replace(
      /((?:api[_-]?key|access[_-]?token|password|secret|private[_-]?key|client[_-]?secret)\s*[=:]\s*)([^\s,}\]]+)/gi,
      '$1[REDACTED]',
    );
}

function runNativeSourceSearch(
  projectRoot: string,
  pattern: string,
  limit: number,
): Array<{ path: string; line: number; text: string }> {
  const matcher = new RegExp(pattern, 'i');
  const matches: Array<{ path: string; line: number; text: string }> = [];
  const directories = [projectRoot];
  let scannedFiles = 0;

  while (directories.length > 0 && matches.length < limit && scannedFiles < 5_000) {
    const directory = directories.pop();
    if (!directory) continue;
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (matches.length >= limit) break;
      const filePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SOURCE_SEARCH_IGNORED_DIRECTORIES.has(entry.name)) directories.push(filePath);
        continue;
      }
      const relativePath = relative(projectRoot, filePath).replaceAll('\\', '/');
      if (!entry.isFile() || !SOURCE_FILE_PATTERN.test(entry.name) || SOURCE_SEARCH_DENIED_FILE.test(relativePath)) continue;
      scannedFiles += 1;
      if (scannedFiles > 5_000) break;
      let source: string;
      try {
        source = readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }
      for (const [index, line] of source.split(/\r?\n/).entries()) {
        if (!matcher.test(line)) continue;
        matches.push({ path: filePath, line: index + 1, text: redactSourceSearchLine(line) });
        if (matches.length >= limit) break;
      }
    }
  }
  return matches;
}

function objectArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {};
}
