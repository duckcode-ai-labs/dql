import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import type {
  ConnectionConfig,
  QueryExecutor,
  QueryResult,
} from "@duckcodeailabs/dql-connectors";

export type DatasetStorageMode = "local" | "project" | "staged";
export type DatasetTrustState =
  | "local_ad_hoc"
  | "project_controlled"
  | "governed_snapshot"
  | "review_required";

export interface DatasetColumn {
  name: string;
  type: string;
  nullable?: boolean;
  nullCount?: number;
  distinctCount?: number;
  sampleValues?: unknown[];
  flags?: Array<"identifier" | "date" | "measure" | "null_heavy" | "sensitive">;
}

export interface DatasetProfile {
  rowCount: number;
  sampledRows: number;
  columns: DatasetColumn[];
  duplicateRows?: number;
  warnings: string[];
  preview: Array<Record<string, unknown>>;
}

export interface DatasetLineage {
  connectionName?: string;
  query?: string;
  blockPath?: string;
  semanticMetrics?: string[];
  semanticDimensions?: string[];
  filters?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  extractedAt?: string;
  rowCount?: number;
  byteCount?: number;
  sourceFingerprint?: string;
  resultFingerprint?: string;
}

export interface DatasetSource {
  id: string;
  name: string;
  alias: string;
  description?: string;
  owner?: string;
  tags: string[];
  sourcePath: string;
  storageMode: DatasetStorageMode;
  format: "csv" | "parquet" | "json";
  fileFingerprint: string;
  sizeBytes: number;
  modifiedAt: string;
  importedAt: string;
  refreshedAt: string;
  profile: DatasetProfile;
  trustState: DatasetTrustState;
  linked?: boolean;
  pinned?: boolean;
  expiresAt?: string;
  lineage?: DatasetLineage;
  schemaDrift?: {
    detectedAt: string;
    added: string[];
    removed: string[];
    changed: Array<{ column: string; before: string; after: string }>;
  };
  schemaOverrides?: Record<string, string>;
}

export interface ImportDatasetInput {
  filename?: string;
  sourcePath?: string;
  /** Base64 encoded file contents. File bodies are never placed in AI context. */
  contentBase64?: string;
  /** Multipart uploads arrive as bytes without JSON/base64 expansion. */
  content?: Buffer;
  storageMode?: "local" | "project";
  link?: boolean;
  name?: string;
  alias?: string;
  description?: string;
  owner?: string;
  tags?: string[];
}

/**
 * RFC 0010, with a host: the engine reads no files for a statement (host/engine-guard.ts). The workspace
 * then reads each uploaded or staged file itself, with a private in-memory engine no statement reaches,
 * and keeps its rows in a table of the workspace database (not a view over the file). `platform` writes
 * that table: DQL's own write of the person's own upload, not a statement they wrote, so it does not pass
 * the host's statement checks. Without a host the workspace keeps views over its files, as before.
 */
export interface NotebookDatasetWorkspaceOptions {
  privateReads?: { platform: QueryExecutor };
}

/** Rows moved from the private reader into the workspace table per statement. */
const TRANSFER_BATCH_ROWS = 20_000;

type ProjectRegistry = {
  version: 1;
  datasets: DatasetSource[];
  [key: string]: unknown;
};
type LocalRegistry = { version: 1; datasets: DatasetSource[] };

export class NotebookDatasetWorkspace {
  readonly localRoot: string;
  readonly datasetRoot: string;
  readonly stagedRoot: string;
  readonly databasePath: string;
  readonly localConnection: ConnectionConfig;

  private readonly platform?: QueryExecutor;

  constructor(
    readonly projectRoot: string,
    private readonly executor: QueryExecutor,
    private readonly moduleSearchPaths?: string[],
    options: NotebookDatasetWorkspaceOptions = {},
  ) {
    this.localRoot = join(projectRoot, ".dql", "local");
    this.datasetRoot = join(this.localRoot, "datasets");
    this.stagedRoot = join(this.datasetRoot, "staged");
    this.databasePath = join(this.localRoot, "notebook.duckdb");
    this.platform = options.privateReads?.platform;
    this.localConnection = {
      driver: "duckdb",
      filepath: this.databasePath,
      ...(moduleSearchPaths?.length ? { moduleSearchPaths } : {}),
      // The same restricted engine the host's statements get, so both use one connection.
      ...(this.platform ? { restrictExternalAccess: true } : {}),
    };
    mkdirSync(this.stagedRoot, { recursive: true });
  }

  /** Whether files are read privately and kept as tables (with a host). */
  get keepsTables(): boolean {
    return Boolean(this.platform);
  }

  list(): DatasetSource[] {
    const byId = new Map<string, DatasetSource>();
    for (const dataset of [
      ...this.readProjectRegistry().datasets,
      ...this.readLocalRegistry().datasets,
    ]) {
      byId.set(dataset.id, dataset);
    }
    return [...byId.values()].sort((a, b) =>
      b.refreshedAt.localeCompare(a.refreshedAt),
    );
  }

  get(id: string): DatasetSource | undefined {
    return this.list().find((dataset) => dataset.id === id);
  }

  async initialize(): Promise<void> {
    for (const dataset of this.list()) {
      if (
        dataset.expiresAt &&
        !dataset.pinned &&
        Date.parse(dataset.expiresAt) < Date.now()
      ) {
        this.remove(dataset.id);
        continue;
      }
      if (!existsSync(this.absolutePath(dataset))) continue;
      // A table already kept for it is current; a view (from a run without a host) is replaced by one.
      if (this.platform && (await this.relationType(dataset.alias)) === "BASE TABLE") continue;
      await this.registerView(dataset);
    }
  }

  async import(
    input: ImportDatasetInput,
  ): Promise<{ dataset: DatasetSource; duplicate: boolean }> {
    const storageMode = input.storageMode ?? "local";
    const originalPath = input.sourcePath
      ? resolve(input.sourcePath)
      : undefined;
    if (
      !input.content &&
      !input.contentBase64 &&
      (!originalPath || !existsSync(originalPath))
    ) {
      throw new Error(
        "Choose a readable CSV file or provide uploaded file contents.",
      );
    }
    const filename = safeFilename(
      input.filename ?? (originalPath ? basename(originalPath) : "dataset.csv"),
    );
    const format = datasetFormat(filename);
    const sourceBuffer =
      input.content ??
      (input.contentBase64
        ? Buffer.from(input.contentBase64, "base64")
        : readFileSync(originalPath!));
    const fingerprint = createHash("sha256").update(sourceBuffer).digest("hex");
    const duplicate = this.list().find(
      (dataset) => dataset.fileFingerprint === fingerprint,
    );
    if (duplicate) return { dataset: duplicate, duplicate: true };

    const alias = uniqueAlias(
      input.alias ?? input.name ?? filename.replace(/\.[^.]+$/, ""),
      this.list(),
    );
    const id = `${alias}_${fingerprint.slice(0, 10)}`;
    let sourcePath: string;
    let linked = false;
    if (storageMode === "project") {
      const targetDir = join(this.projectRoot, "data");
      mkdirSync(targetDir, { recursive: true });
      const target = uniqueFilePath(join(targetDir, filename));
      if (input.content || input.contentBase64)
        writeFileSync(target, sourceBuffer);
      else copyFileSync(originalPath!, target);
      sourcePath = relative(this.projectRoot, target).replaceAll("\\", "/");
    } else if (input.link && originalPath) {
      sourcePath = originalPath;
      linked = true;
    } else {
      const target = uniqueFilePath(join(this.datasetRoot, filename));
      writeFileSync(target, sourceBuffer);
      sourcePath = relative(this.projectRoot, target).replaceAll("\\", "/");
    }

    const absolutePath = resolveStoredPath(this.projectRoot, sourcePath);
    const now = new Date().toISOString();
    const profile = await this.inspect(absolutePath, format);
    const stat = statSync(absolutePath);
    const dataset: DatasetSource = {
      id,
      name: input.name?.trim() || filename.replace(/\.[^.]+$/, ""),
      alias,
      description: input.description?.trim() || undefined,
      owner: input.owner?.trim() || undefined,
      tags: cleanStrings(input.tags),
      sourcePath,
      storageMode,
      format,
      fileFingerprint: fingerprint,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      importedAt: now,
      refreshedAt: now,
      profile,
      trustState:
        storageMode === "project" ? "project_controlled" : "local_ad_hoc",
      ...(linked ? { linked: true } : {}),
    };
    this.upsert(dataset);
    await this.registerView(dataset);
    return { dataset, duplicate: false };
  }

  async refresh(id: string): Promise<DatasetSource> {
    const current = this.require(id);
    const path = this.absolutePath(current);
    if (!existsSync(path))
      throw new Error(`Dataset file is missing: ${current.sourcePath}`);
    const buffer = readFileSync(path);
    const fingerprint = createHash("sha256").update(buffer).digest("hex");
    const nextProfile = await this.inspect(path, current.format);
    const stat = statSync(path);
    const previousColumns = new Map(
      current.profile.columns.map((column) => [column.name, column.type]),
    );
    const nextColumns = new Map(
      nextProfile.columns.map((column) => [column.name, column.type]),
    );
    const added = [...nextColumns.keys()].filter(
      (name) => !previousColumns.has(name),
    );
    const removed = [...previousColumns.keys()].filter(
      (name) => !nextColumns.has(name),
    );
    const changed = [...nextColumns.entries()]
      .filter(
        ([name, type]) =>
          previousColumns.has(name) &&
          !current.schemaOverrides?.[name] &&
          previousColumns.get(name) !== type,
      )
      .map(([column, after]) => ({
        column,
        before: previousColumns.get(column)!,
        after,
      }));
    const profiledWithOverrides: DatasetProfile = current.schemaOverrides
      ? {
          ...nextProfile,
          columns: nextProfile.columns.map((column) => ({
            ...column,
            type: current.schemaOverrides?.[column.name] ?? column.type,
          })),
        }
      : nextProfile;
    const next: DatasetSource = {
      ...current,
      fileFingerprint: fingerprint,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      refreshedAt: new Date().toISOString(),
      profile: profiledWithOverrides,
      ...(added.length || removed.length || changed.length
        ? {
            schemaDrift: {
              detectedAt: new Date().toISOString(),
              added,
              removed,
              changed,
            },
          }
        : { schemaDrift: undefined }),
    };
    this.upsert(next);
    await this.registerView(next);
    return next;
  }

  rename(id: string, name: string, alias?: string): DatasetSource {
    const current = this.require(id);
    const nextAlias = alias
      ? uniqueAlias(
          alias,
          this.list().filter((dataset) => dataset.id !== id),
        )
      : current.alias;
    const next = {
      ...current,
      name: name.trim() || current.name,
      alias: nextAlias,
    };
    this.upsert(next);
    return next;
  }

  async updateSchema(
    id: string,
    overrides: Record<string, string>,
  ): Promise<DatasetSource> {
    const current = this.require(id);
    const columnNames = new Set(
      current.profile.columns.map((column) => column.name),
    );
    const clean = Object.fromEntries(
      Object.entries(overrides)
        .filter(
          ([name, type]) => columnNames.has(name) && validDuckDbType(type),
        )
        .map(([name, type]) => [name, type.trim().toUpperCase()]),
    );
    const next: DatasetSource = {
      ...current,
      schemaOverrides: clean,
      profile: {
        ...current.profile,
        columns: current.profile.columns.map((column) => ({
          ...column,
          type: clean[column.name] ?? column.type,
        })),
      },
    };
    this.upsert(next);
    await this.registerView(next);
    return next;
  }

  pin(id: string, pinned: boolean): DatasetSource {
    const current = this.require(id);
    const next = {
      ...current,
      pinned,
      ...(pinned ? { expiresAt: undefined } : {}),
    };
    this.upsert(next);
    return next;
  }

  remove(id: string): void {
    const dataset = this.get(id);
    if (!dataset) return;
    const local = this.readLocalRegistry();
    const project = this.readProjectRegistry();
    local.datasets = local.datasets.filter((item) => item.id !== id);
    project.datasets = project.datasets.filter((item) => item.id !== id);
    this.writeLocalRegistry(local);
    this.writeProjectRegistry(project);
    if (!dataset.linked && dataset.storageMode !== "project") {
      const path = this.absolutePath(dataset);
      if (existsSync(path)) rmSync(path, { force: true });
    }
    if (this.platform) {
      void this.dropRelation(dataset.alias).catch(() => undefined);
      return;
    }
    void this.executor
      .executeQuery(
        `DROP VIEW IF EXISTS ${quoteIdentifier(dataset.alias)}`,
        [],
        {},
        this.localConnection,
      )
      .catch(() => undefined);
  }

  async stageRows(input: {
    name: string;
    rows: Array<Record<string, unknown>>;
    lineage: DatasetLineage;
    expiresInDays?: number;
  }): Promise<DatasetSource> {
    if (input.rows.length === 0)
      throw new Error("The warehouse query returned no rows to stage.");
    const alias = uniqueAlias(input.name || "staged_result", this.list());
    const id = `${alias}_${randomUUID().slice(0, 10)}`;
    const jsonPath = join(this.stagedRoot, `${id}.ndjson`);
    const parquetPath = join(this.stagedRoot, `${id}.parquet`);
    const body =
      input.rows.map((row) => JSON.stringify(row, bigintReplacer)).join("\n") +
      "\n";
    writeFileSync(jsonPath, body, "utf-8");
    const copy = `COPY (SELECT * FROM read_json_auto(${quoteLiteral(jsonPath.replaceAll("\\", "/"))})) TO ${quoteLiteral(parquetPath.replaceAll("\\", "/"))} (FORMAT PARQUET)`;
    if (this.platform) await this.withPrivateReader((run) => run(copy));
    else await this.executor.executeQuery(copy, [], {}, this.localConnection);
    rmSync(jsonPath, { force: true });
    const buffer = readFileSync(parquetPath);
    const now = new Date();
    const profile = await this.inspect(parquetPath, "parquet");
    const dataset: DatasetSource = {
      id,
      name: input.name || "Staged warehouse result",
      alias,
      tags: ["staged"],
      sourcePath: relative(this.projectRoot, parquetPath).replaceAll("\\", "/"),
      storageMode: "staged",
      format: "parquet",
      fileFingerprint: createHash("sha256").update(buffer).digest("hex"),
      sizeBytes: buffer.byteLength,
      modifiedAt: statSync(parquetPath).mtime.toISOString(),
      importedAt: now.toISOString(),
      refreshedAt: now.toISOString(),
      profile,
      trustState: "review_required",
      expiresAt: new Date(
        now.getTime() + (input.expiresInDays ?? 7) * 86_400_000,
      ).toISOString(),
      lineage: input.lineage,
    };
    this.upsert(dataset);
    await this.registerView(dataset);
    return dataset;
  }

  async registerView(dataset: DatasetSource): Promise<void> {
    const reader = readerFor(dataset.format);
    const source = `${reader}(${quoteLiteral(this.absolutePath(dataset).replaceAll("\\", "/"))})`;
    const projection =
      dataset.schemaOverrides && Object.keys(dataset.schemaOverrides).length > 0
        ? dataset.profile.columns
            .map((column) =>
              dataset.schemaOverrides?.[column.name]
                ? `TRY_CAST(${quoteIdentifier(column.name)} AS ${dataset.schemaOverrides[column.name]}) AS ${quoteIdentifier(column.name)}`
                : quoteIdentifier(column.name),
            )
            .join(", ")
        : "*";
    if (this.platform) {
      await this.keepAsTable(dataset.alias, `SELECT ${projection} FROM ${source}`);
      return;
    }
    await this.executor.executeQuery(
      `CREATE OR REPLACE VIEW ${quoteIdentifier(dataset.alias)} AS SELECT ${projection} FROM ${source}`,
      [],
      {},
      this.localConnection,
    );
  }

  private async inspect(
    path: string,
    format: DatasetSource["format"],
  ): Promise<DatasetProfile> {
    const relation = `${readerFor(format)}(${quoteLiteral(path.replaceAll("\\", "/"))})`;
    const [description, countResult, previewResult] = this.platform
      ? await this.withPrivateReader(async (run) => [
          await run(`DESCRIBE SELECT * FROM ${relation}`),
          await run(`SELECT COUNT(*) AS row_count FROM ${relation}`),
          await run(`SELECT * FROM ${relation} LIMIT 100`),
        ])
      : await Promise.all([
      this.executor.executeQuery(
        `DESCRIBE SELECT * FROM ${relation}`,
        [],
        {},
        this.localConnection,
      ),
      this.executor.executeQuery(
        `SELECT COUNT(*) AS row_count FROM ${relation}`,
        [],
        {},
        this.localConnection,
      ),
      this.executor.executeQuery(
        `SELECT * FROM ${relation} LIMIT 100`,
        [],
        {},
        this.localConnection,
      ),
    ]);
    const preview = (previewResult.rows ?? []) as Array<
      Record<string, unknown>
    >;
    const rowCount = Number(
      (countResult.rows?.[0] as Record<string, unknown> | undefined)
        ?.row_count ?? preview.length,
    );
    const columns = (description.rows ?? []).map((raw) => {
      const row = raw as Record<string, unknown>;
      const name = String(row.column_name ?? row.name ?? "column");
      const type = String(row.column_type ?? row.type ?? "VARCHAR");
      const values = preview.map((item) => item[name]);
      const nullCount = values.filter(
        (value) => value === null || value === undefined || value === "",
      ).length;
      const nonNull = values.filter(
        (value) => value !== null && value !== undefined && value !== "",
      );
      const distinct = new Set(nonNull.map((value) => String(value))).size;
      const flags: DatasetColumn["flags"] = [];
      if (
        /(^id$|_id$|^key$|_key$)/i.test(name) ||
        (nonNull.length >= 20 && distinct === nonNull.length)
      )
        flags.push("identifier");
      if (/date|time|timestamp/i.test(name) || /DATE|TIME/i.test(type))
        flags.push("date");
      if (/INT|DECIMAL|DOUBLE|FLOAT|NUMERIC|REAL/i.test(type))
        flags.push("measure");
      if (values.length > 0 && nullCount / values.length >= 0.5)
        flags.push("null_heavy");
      if (
        /email|phone|address|ssn|social.security|dob|birth|first_name|last_name/i.test(
          name,
        )
      )
        flags.push("sensitive");
      return {
        name,
        type,
        nullable:
          String(row.null ?? row.nullable ?? "YES").toUpperCase() !== "NO",
        nullCount,
        distinctCount: distinct,
        sampleValues: nonNull.slice(0, 5),
        flags,
      };
    });
    const warnings: string[] = [];
    if (columns.some((column) => column.flags?.includes("sensitive")))
      warnings.push(
        "Potential sensitive fields detected. Samples are redacted from AI context by default.",
      );
    if (columns.some((column) => column.flags?.includes("null_heavy")))
      warnings.push(
        "One or more columns are at least 50% null in the bounded preview.",
      );
    return {
      rowCount,
      sampledRows: preview.length,
      columns,
      warnings,
      preview,
    };
  }

  /**
   * With a host: a private in-memory engine, for reading the workspace's own files (an upload, a staged
   * result). It is reached only through the server's own executor with this connection, which no
   * statement a person writes uses (theirs are restricted); each use works in tables of its own, dropped
   * afterwards.
   */
  private async withPrivateReader<T>(
    work: (run: (sql: string) => Promise<QueryResult>, table: string) => Promise<T>,
  ): Promise<T> {
    const platform = this.platform!;
    const reader: ConnectionConfig = {
      driver: "duckdb",
      filepath: ":memory:",
      ...(this.moduleSearchPaths?.length ? { moduleSearchPaths: this.moduleSearchPaths } : {}),
    };
    const run = (sql: string) => platform.executePositional(sql, [], reader);
    const table = `dql_upload_${randomUUID().replaceAll("-", "")}`;
    // Formats are read with what is already on this machine; nothing is fetched.
    await run("SET autoinstall_known_extensions = false");
    try {
      return await work(run, table);
    } finally {
      await run(`DROP TABLE IF EXISTS ${quoteIdentifier(table)}`).catch(() => undefined);
    }
  }

  /** The kind of relation the workspace database holds under this name (`BASE TABLE`, `VIEW`), if any. */
  private async relationType(name: string): Promise<string | undefined> {
    if (!this.platform) return undefined;
    const result = await this.platform.executePositional(
      "SELECT table_type FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?",
      [name],
      this.localConnection,
    );
    const type = (result.rows?.[0] as Record<string, unknown> | undefined)?.table_type;
    return typeof type === "string" ? type : undefined;
  }

  private async dropRelation(name: string): Promise<void> {
    if (!this.platform) return;
    const type = await this.relationType(name);
    if (!type) return;
    await this.platform.executePositional(
      `DROP ${type === "VIEW" ? "VIEW" : "TABLE"} IF EXISTS ${quoteIdentifier(name)}`,
      [],
      this.localConnection,
    );
  }

  /**
   * With a host: read the file with the private engine and keep its rows in a table of the workspace
   * database. Values travel as text, in DuckDB's own text form, and are cast back to their types.
   */
  private async keepAsTable(alias: string, select: string): Promise<void> {
    const platform = this.platform!;
    await this.withPrivateReader(async (run, src) => {
      await run(`CREATE TABLE ${quoteIdentifier(src)} AS ${select}`);
      const columns = ((await run(`DESCRIBE ${quoteIdentifier(src)}`)).rows ?? []).map((raw) => {
        const row = raw as Record<string, unknown>;
        return { name: String(row.column_name ?? row.name), type: String(row.column_type ?? row.type ?? "VARCHAR") };
      });
      if (!columns.length) throw new Error("The dataset file has no columns.");
      const total = Number(((await run(`SELECT COUNT(*) AS n FROM ${quoteIdentifier(src)}`)).rows?.[0] as Record<string, unknown> | undefined)?.n ?? 0);
      await this.dropRelation(alias);
      await platform.executePositional(
        `CREATE TABLE ${quoteIdentifier(alias)} (${columns.map((column) => `${quoteIdentifier(column.name)} ${column.type}`).join(", ")})`,
        [],
        this.localConnection,
      );
      const asText = columns.map((column) => `${quoteIdentifier(column.name)} := CAST(${quoteIdentifier(column.name)} AS VARCHAR)`).join(", ");
      const shape = quoteLiteral(JSON.stringify([Object.fromEntries(columns.map((column) => [column.name, "VARCHAR"]))]));
      const typed = columns.map((column) => `CAST(r.${quoteIdentifier(column.name)} AS ${column.type})`).join(", ");
      for (let offset = 0; offset < total; offset += TRANSFER_BATCH_ROWS) {
        const batch = await run(
          `SELECT CAST(to_json(list(struct_pack(${asText}))) AS VARCHAR) AS rows_json FROM (SELECT * FROM ${quoteIdentifier(src)} WHERE rowid >= ${offset} AND rowid < ${offset + TRANSFER_BATCH_ROWS})`,
        );
        const json = (batch.rows?.[0] as Record<string, unknown> | undefined)?.rows_json;
        if (typeof json !== "string" || json === "[]") continue;
        await platform.executePositional(
          `INSERT INTO ${quoteIdentifier(alias)} SELECT ${typed} FROM (SELECT unnest(from_json(CAST(? AS JSON), ${shape})) AS r)`,
          [json],
          this.localConnection,
        );
      }
    });
  }

  private require(id: string): DatasetSource {
    const dataset = this.get(id);
    if (!dataset) throw new Error(`Dataset not found: ${id}`);
    return dataset;
  }

  private absolutePath(dataset: DatasetSource): string {
    return resolveStoredPath(this.projectRoot, dataset.sourcePath);
  }

  private upsert(dataset: DatasetSource): void {
    if (dataset.storageMode === "project") {
      const registry = this.readProjectRegistry();
      registry.datasets = [
        ...registry.datasets.filter((item) => item.id !== dataset.id),
        dataset,
      ];
      this.writeProjectRegistry(registry);
    } else {
      const registry = this.readLocalRegistry();
      registry.datasets = [
        ...registry.datasets.filter((item) => item.id !== dataset.id),
        dataset,
      ];
      this.writeLocalRegistry(registry);
    }
  }

  private readLocalRegistry(): LocalRegistry {
    const path = join(this.datasetRoot, "registry.json");
    if (!existsSync(path)) return { version: 1, datasets: [] };
    try {
      const parsed = JSON.parse(
        readFileSync(path, "utf-8"),
      ) as Partial<LocalRegistry>;
      return {
        version: 1,
        datasets: Array.isArray(parsed.datasets) ? parsed.datasets : [],
      };
    } catch {
      return { version: 1, datasets: [] };
    }
  }

  private writeLocalRegistry(registry: LocalRegistry): void {
    mkdirSync(this.datasetRoot, { recursive: true });
    writeFileSync(
      join(this.datasetRoot, "registry.json"),
      JSON.stringify(registry, null, 2) + "\n",
      "utf-8",
    );
  }

  private readProjectRegistry(): ProjectRegistry {
    const path = join(this.projectRoot, "data", "sources.yml");
    if (!existsSync(path)) return { version: 1, datasets: [] };
    try {
      const parsed = loadYaml(
        readFileSync(path, "utf-8"),
      ) as Partial<ProjectRegistry> | null;
      return {
        ...(parsed && typeof parsed === "object" ? parsed : {}),
        version: 1,
        datasets: Array.isArray(parsed?.datasets) ? parsed.datasets : [],
      };
    } catch {
      return { version: 1, datasets: [] };
    }
  }

  private writeProjectRegistry(registry: ProjectRegistry): void {
    const dir = join(this.projectRoot, "data");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "sources.yml");
    if (registry.datasets.length === 0 && !existsSync(path)) return;
    writeFileSync(
      path,
      dumpYaml(registry, { noRefs: true, lineWidth: 120, sortKeys: false }),
      "utf-8",
    );
  }
}

function resolveStoredPath(projectRoot: string, path: string): string {
  return resolve(path.startsWith("/") ? path : join(projectRoot, path));
}

function datasetFormat(filename: string): DatasetSource["format"] {
  const extension = extname(filename).toLowerCase();
  if (extension === ".csv") return "csv";
  if (extension === ".parquet") return "parquet";
  if (
    extension === ".json" ||
    extension === ".jsonl" ||
    extension === ".ndjson"
  )
    return "json";
  throw new Error(
    "CSV is supported now. Parquet and JSON are accepted for compatible files.",
  );
}

function readerFor(format: DatasetSource["format"]): string {
  return format === "parquet"
    ? "read_parquet"
    : format === "json"
      ? "read_json_auto"
      : "read_csv_auto";
}

function safeFilename(value: string): string {
  const cleaned = basename(value).replace(/[^A-Za-z0-9._-]+/g, "_");
  return cleaned || "dataset.csv";
}

function safeAlias(value: string): string {
  const alias = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return alias || "dataset";
}

function uniqueAlias(value: string, existing: DatasetSource[]): string {
  const base = safeAlias(value);
  const used = new Set(existing.map((dataset) => dataset.alias.toLowerCase()));
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base}_${index}`)) index += 1;
  return `${base}_${index}`;
}

function uniqueFilePath(path: string): string {
  if (!existsSync(path)) return path;
  const extension = extname(path);
  const stem = path.slice(0, -extension.length);
  let index = 2;
  while (existsSync(`${stem}_${index}${extension}`)) index += 1;
  return `${stem}_${index}${extension}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function cleanStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter(
          (item): item is string =>
            typeof item === "string" && item.trim().length > 0,
        )
        .map((item) => item.trim())
    : [];
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? Number(value) : value;
}

function validDuckDbType(value: string): boolean {
  return /^(VARCHAR|TEXT|BOOLEAN|BOOL|TINYINT|SMALLINT|INTEGER|INT|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|REAL|FLOAT|DOUBLE|DECIMAL(?:\(\d{1,3},\s*\d{1,3}\))?|DATE|TIME|TIMESTAMP|TIMESTAMPTZ|JSON)$/i.test(
    value.trim(),
  );
}
