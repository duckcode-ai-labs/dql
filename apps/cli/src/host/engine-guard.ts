import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import type { ConnectionConfig } from '@duckcodeailabs/dql-connectors';
import { lexStatement, type SqlToken } from './sql-lexicon.js';

/**
 * THE ENGINE REACHES THE DATABASE ONLY (RFC 0010, with a host). When DQL
 * serves people through a host, a statement may read the connection's tables
 * and views and nothing else the engine could reach: no file, no environment
 * variable, no extension, no other database, no setting.
 *
 * Two layers. The first is the engine's own: every DuckDB (and file)
 * connection is opened restricted (`restrictExternalAccess`: external access
 * off and settings locked, after the database itself is open). The second is
 * this statement check, for every engine, which refuses the same families
 * where DQL can see them in the statement's text: file readers and
 * replacement scans, `getenv`, queries given as text, COPY, ATTACH, INSTALL,
 * LOAD, PRAGMA, SET and RESET, EXPORT and IMPORT DATABASE, and their
 * counterparts on other engines (`pg_read_file`, `LOAD DATA`, `INTO OUTFILE`,
 * `load_extension`, stages, PUT and GET, path-based tables, table functions
 * that reach files, URLs or other servers, procedures and dynamic SQL). On
 * DuckDB the engine refuses these whatever the text says; on other engines the
 * check is the layer DQL owns, so it reads the statement the way that engine
 * reads it (sql-lexicon.ts) and refuses what it cannot read.
 *
 * Statements a person or a model writes (Ask, notebook cells, App tiles, the
 * query API, MCP, Slack) also only READ, on every connection: one statement,
 * a SELECT (or WITH, VALUES, TABLE, SHOW, DESCRIBE, EXPLAIN of one), never
 * a change to data, objects, settings or the session. Statements DQL issues
 * itself (purpose `platform`, never set from a request) keep their own
 * shapes. Nor do they read the warehouse's own record of other sessions,
 * their queries, its users or its settings (query-history and activity
 * views, server settings and variables, SHOW of the same), engine by engine.
 * The warehouse role behind a hosted connection should still be read only,
 * with no grant on those views: this check is not a substitute for it.
 *
 * A connection may name folders whose files stay readable
 * (`allowedDirectories`, none by default): a file reader whose path is a
 * plain string inside one of them is let through.
 *
 * Without a host none of this applies.
 */
export const HOSTED_STATEMENT_REFUSED = 'DQL did not run this statement: it reads a file, the server\'s environment or settings, or loads an extension, and DQL runs statements on the tables and views of the connection only. Ask about those tables instead; an admin can allow a folder of data files in the connection\'s settings (allowedDirectories).';
export const HOSTED_STATEMENT_UNREADABLE = 'DQL could not read this statement closely enough to check what it reaches, so it did not run it.';
export const HOSTED_READ_ONLY_REFUSED = 'DQL did not run this statement: here a statement only reads data, one at a time, and this one would change data, objects or settings, or holds more than one statement. Ask with one SELECT that reads what you need.';
export const HOSTED_SYSTEM_RELATION_REFUSED = 'DQL did not run this statement: it reads the warehouse\'s own record of sessions, queries, users or settings, and here DQL reads the connection\'s data only. Ask about the data tables instead.';

/** DuckDB and file connections are opened with the engine restricted. */
export function restrictedEngineConnection(config: ConnectionConfig): ConnectionConfig {
  if (config.driver !== 'duckdb' && config.driver !== 'file') return config;
  return config.restrictExternalAccess ? config : { ...config, restrictExternalAccess: true };
}

/** The engine's own refusal of a restricted statement (DuckDB's permission error, or its locked settings). */
export function isEngineRestrictionError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const message = current instanceof Error ? current.message : typeof current === 'string' ? current : '';
    if (/Permission Error:|disabled (?:through|by) configuration|the configuration has been locked/i.test(message)) return true;
    current = current && typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/** Statements that reach beyond the connection's tables: refused wherever they begin a statement, whoever issues them. */
const REFUSED_STATEMENTS = new Set([
  'copy', 'attach', 'detach', 'install', 'force', 'load', 'pragma', 'set', 'unset', 'reset', 'export', 'import',
  'put', 'get', 'unload', 'vacuum', 'use', 'prepare', 'execute', 'exec', 'call', 'list', 'ls', 'remove', 'rm', 'add',
]);

/** Readers of files (allowed in an allowed folder, with a plain path). */
const FILE_READER = /^(?:read_[a-z0-9_]*|glob|sniff_csv|parquet_scan|parquet_metadata|parquet_schema|parquet_file_metadata|parquet_kv_metadata|st_read|st_read_meta|st_readosm|iceberg_scan|iceberg_metadata|iceberg_snapshots|delta_scan)$/;
/** Functions that reach files, other databases, the environment, or run a query given as text: always refused, on every engine. */
const REFUSED_FUNCTION = /^(?:getenv|query|query_table|sqlite_scan|sqlite_query|sqlite_attach|postgres_[a-z_]+|mysql_[a-z_]+|load_extension|readfile|writefile|pg_read_file|pg_read_binary_file|pg_ls_[a-z_]+|pg_stat_file|lo_import|lo_export|dblink[a-z_]*|load_file|duckdb_secrets|which_secret)$/;
const REFUSED_FUNCTION_NAMES = String.raw`getenv|query|query_table|sqlite_[a-z_]+|postgres_[a-z_]+|mysql_[a-z_]+|load_extension|readfile|writefile|pg_read_file|pg_read_binary_file|pg_ls_[a-z_]+|pg_stat_file|lo_import|lo_export|dblink[a-z_]*|load_file|duckdb_secrets|which_secret`;
const READER_NAMES = String.raw`read_[a-z0-9_]*|glob|sniff_csv|parquet_[a-z_]+|st_read[a-z_]*|iceberg_[a-z_]+|delta_scan`;

/**
 * Each engine's own families beyond the tables (functions, by name): files, URLs, stages and other servers;
 * dynamic SQL and query text; secrets; the server's sessions, settings and locks; other statements' results.
 */
const ENGINE_FUNCTIONS: Record<string, string> = {
  postgresql: String.raw`lo_[a-z_]+|query_to_xml[a-z_]*|table_to_xml[a-z_]*|cursor_to_xml[a-z_]*|schema_to_xml[a-z_]*|database_to_xml[a-z_]*|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|set_config|pg_advisory_[a-z_]+|pg_try_advisory_[a-z_]+|pg_notify|pg_logical_[a-z_]+|pg_create_[a-z_]+|pg_drop_[a-z_]+|pg_replication_[a-z_]+|pg_switch_wal|pg_promote|pg_file_[a-z_]+|pg_logdir_ls|pg_import_system_collations`,
  redshift: String.raw`lo_[a-z_]+|query_to_xml[a-z_]*|table_to_xml[a-z_]*|pg_terminate_backend|pg_cancel_backend|set_config|pg_advisory_[a-z_]+`,
  snowflake: String.raw`system\$[a-z0-9_$]*|get_presigned_url|build_scoped_file_url|build_stage_file_url|get_stage_location|get_relative_path|get_absolute_path|infer_schema|result_scan|last_query_id|query_history[a-z_]*|login_history[a-z_]*|copy_history|external_[a-z_]+`,
  bigquery: String.raw`external_query|external_object_transform`,
  databricks: String.raw`cloud_files|reflect|try_reflect|java_method|secret|try_secret|http_request|ai_[a-z_]+|list_secrets`,
  mysql: String.raw`sys_exec|sys_eval|get_lock|release_lock|release_all_locks|master_pos_wait|source_pos_wait`,
  sqlite: String.raw`fsdir|zipfile|edit|fts3_tokenizer|sqlar_[a-z_]+`,
  mssql: String.raw`openrowset|opendatasource|openquery|xp_[a-z_]+|sp_[a-z_]+`,
  fabric: String.raw`openrowset|opendatasource|openquery|xp_[a-z_]+|sp_[a-z_]+`,
  clickhouse: String.raw`file|url|urlcluster|s3|s3cluster|hdfs|hdfscluster|azureblobstorage|azureblobstoragecluster|gcs|cosn|oss|mysql|postgresql|jdbc|odbc|mongodb|redis|sqlite|executable|remote|remotesecure|cluster|clusterallreplicas|input|iceberg|deltalake|hudi|hive|merge|dictget[a-z]*`,
  trino: '',
  athena: '',
  duckdb: '',
  file: '',
};
/** BigQuery calls models and objects through these prefixes (`ML.PREDICT`, `AI.GENERATE`, `OBJ.GET_ACCESS_URL`). */
const BIGQUERY_PREFIXES = new Set(['ml', 'ai', 'obj']);
/** Spark reads a file as a table named by its path: `csv.`/path``. */
const PATH_TABLE_FORMATS = new Set(['csv', 'json', 'parquet', 'orc', 'avro', 'text', 'binaryfile', 'delta', 'xml', 'iceberg', 'hudi', 'jdbc', 'cloudfiles']);

/** Words that end a FROM clause at its own depth. */
const AFTER_FROM = new Set(['where', 'group', 'having', 'qualify', 'window', 'order', 'limit', 'offset', 'union', 'except', 'intersect', 'on', 'using', 'select', 'returning', 'fetch', 'for', 'into', 'pivot', 'unpivot']);
/** Words before a statement's own first word that do not change what it is. */
const PREFIX_WORDS = new Set(['explain', 'analyze', 'analyse', 'verbose', 'describe', 'summarize']);

/** How a statement a person or a model writes may begin: it reads. */
const READ_STARTS = new Set(['select', 'with', 'values', 'table', 'from', 'show', 'describe', 'desc', 'summarize', 'pivot', 'unpivot', 'explain']);
/** Statements that change something (or the session), refused where a statement a person or a model writes begins. */
const WRITE_STARTS = new Set([
  'insert', 'update', 'delete', 'merge', 'upsert', 'replace', 'create', 'drop', 'alter', 'truncate', 'grant', 'revoke', 'call', 'exec', 'execute',
  'copy', 'put', 'get', 'remove', 'rm', 'list', 'ls', 'unload', 'vacuum', 'optimize', 'analyze', 'analyse', 'refresh', 'cache', 'uncache', 'msck',
  'comment', 'rename', 'lock', 'unlock', 'begin', 'commit', 'rollback', 'abort', 'start', 'end', 'savepoint', 'release', 'set', 'unset', 'reset',
  'use', 'declare', 'prepare', 'deallocate', 'load', 'install', 'attach', 'detach', 'export', 'import', 'pragma', 'checkpoint', 'force', 'kill',
  'flush', 'do', 'handler', 'undrop', 'restore', 'backup', 'add', 'purge', 'reindex', 'cluster', 'discard', 'notify', 'listen', 'security', 'reassign',
]);
/** Words that only a change uses, refused anywhere in a statement a person or a model writes. */
const WRITE_WORDS = new Set(['insert', 'update', 'delete', 'drop', 'alter', 'create', 'grant', 'revoke', 'into']);
/** A change that can begin inside parentheses (a CTE body, a subquery). */
const NESTED_WRITE_STARTS = new Set([...WRITE_WORDS, 'merge', 'upsert', 'truncate']);
const EXPLAIN = new Set(['explain']);
const EXPLAIN_OPTIONS = new Set(['explain', 'analyze', 'analyse']);
const INTO = new Set(['into']);
const NAME = new Set(['name']);
const UNPIVOT = new Set(['unpivot']);
const SHARE = new Set(['share']);
const FOR_OR_KEY = new Set(['for', 'key']);
const LOCK = new Set(['lock']);
const IN = new Set(['in']);
const FROM_OR_JOIN = new Set(['from', 'join']);
const FROM = new Set(['from']);
const OUTFILE = new Set(['outfile', 'dumpfile']);
const CREATE = new Set(['create']);
/** Functions with an effect (a sequence moves on): refused in a statement a person or a model writes. */
const EFFECT_FUNCTION = /^(?:nextval|setval)$/;

/**
 * The warehouse's own record of other sessions, their queries, its users and its settings, by engine: views and
 * table functions named (in any case, quoted or not, however qualified) by a run of a dotted name's parts.
 * `seq` matches consecutive parts anywhere in the name; a `bare` name matches when it stands alone or after one of
 * the engine's own system schemas (`pg_catalog.pg_settings`), never as another schema's table or a column of an
 * alias (`t.pg_settings`). Refused in a statement a person or a model writes; the warehouse role's grants stay the
 * first control.
 */
interface SystemRelationRule {
  seq: RegExp[];
  bare?: boolean;
}
const POSTGRES_SYSTEM = /^(?:pg_stat_activity|pg_stat_statements(?:_info)?|pg_settings|pg_file_settings|pg_hba_file_rules|pg_ident_file_mappings|pg_stat_replication|pg_stat_wal_receiver|pg_stat_ssl|pg_stat_gssapi|pg_locks|pg_shadow|pg_authid|pg_user_mappings?|pg_stat_get_activity|pg_stat_get_backend_[a-z_]+|pg_show_all_settings|pg_show_all_file_settings|pg_blocking_pids|current_setting)$/;
const SYSTEM_RELATIONS: Record<string, SystemRelationRule[]> = {
  postgresql: [{ seq: [POSTGRES_SYSTEM], bare: true }],
  redshift: [
    { seq: [POSTGRES_SYSTEM], bare: true },
    { seq: [/^(?:stl|svl|stv)_[a-z0-9_]+$|^sys_(?:query_[a-z0-9_]+|session_history|connection_log|userlog)$/], bare: true },
  ],
  snowflake: [{ seq: [/^(?:account_usage|organization_usage|reader_account_usage)$/, /^(?:query_history|login_history|sessions|access_history)$/] }],
  databricks: [{ seq: [/^system$/, /^(?:access|billing)$/] }, { seq: [/^query$/, /^history$/] }],
  bigquery: [{ seq: [/^information_schema$/, /^(?:jobs|sessions)(?:_[a-z_]+)?$/] }],
  mysql: [{ seq: [/^(?:performance_schema|mysql|sys)$/, /./] }, { seq: [/^information_schema$/, /^(?:processlist|innodb_trx)$/] }],
  duckdb: [{ seq: [/^(?:duckdb_settings|duckdb_secrets|duckdb_extensions|duckdb_databases|pg_settings|current_setting|which_secret)$/], bare: true }],
  file: [{ seq: [/^(?:duckdb_settings|duckdb_secrets|duckdb_extensions|duckdb_databases|pg_settings|current_setting|which_secret)$/], bare: true }],
  clickhouse: [{ seq: [/^system$/, /^(?:processes|query_log|query_thread_log|query_views_log|session_log|text_log|trace_log|crash_log|settings|server_settings|users|grants|roles|role_grants|quotas|settings_profiles|zookeeper)$/] }],
  trino: [{ seq: [/^runtime$/, /^(?:queries|tasks|nodes|transactions)$/] }],
  athena: [{ seq: [/^runtime$/, /^(?:queries|tasks|nodes|transactions)$/] }],
  mssql: [{ seq: [/^sys$/, /^(?:dm_exec_[a-z_]+|dm_os_[a-z_]+|dm_tran_[a-z_]+|configurations|sql_logins|server_principals|credentials|database_scoped_credentials|syslogins)$/] }],
  fabric: [{ seq: [/^sys$/, /^(?:dm_exec_[a-z_]+|dm_os_[a-z_]+|dm_tran_[a-z_]+|configurations|sql_logins|server_principals|credentials|database_scoped_credentials|syslogins)$/] }],
  sqlite: [],
};
/** Schemas a bare system name may stand after (`pg_catalog.pg_stat_activity`, DuckDB's `main`). */
const SYSTEM_SCHEMAS = /^(?:pg_catalog|main|system|temp)$/;
/**
 * What SHOW may list where SHOW also lists sessions, users, grants or settings: after the words in `skip`, the
 * next word must be in `words` (and a word in `then` followed by one of its words); anything else is refused.
 * Postgres SHOW only reads settings: none.
 */
const SHOW_ALLOWED: Record<string, { skip?: Set<string>; words: Set<string>; then?: Record<string, Set<string>> }> = {
  postgresql: { words: new Set() },
  redshift: { words: new Set(['table', 'tables', 'column', 'columns', 'schemas', 'databases', 'view', 'datashares', 'model', 'models']) },
  mysql: {
    skip: new Set(['extended', 'full']),
    words: new Set(['tables', 'columns', 'fields', 'index', 'indexes', 'keys', 'databases', 'schemas', 'table', 'warnings', 'errors', 'character', 'charset', 'collation', 'create']),
    then: { create: new Set(['table', 'view', 'database', 'schema']) },
  },
  snowflake: {
    skip: new Set(['terse']),
    words: new Set(['tables', 'views', 'schemas', 'databases', 'columns', 'objects', 'materialized', 'dynamic', 'iceberg', 'external', 'primary', 'unique', 'imported', 'semantic', 'warehouses']),
    then: { external: new Set(['tables']), semantic: new Set(['views']) },
  },
  databricks: { words: new Set(['tables', 'table', 'views', 'schemas', 'databases', 'catalogs', 'columns', 'partitions', 'tblproperties', 'create']), then: { create: new Set(['table']) } },
  clickhouse: { words: new Set(['tables', 'databases', 'columns', 'dictionaries', 'index', 'indexes', 'keys', 'create']), then: { create: new Set(['table', 'view', 'dictionary', 'database']) } },
  trino: { words: new Set(['tables', 'schemas', 'catalogs', 'columns', 'stats', 'functions', 'create']), then: { create: new Set(['table', 'view', 'materialized']) } },
  athena: { words: new Set(['tables', 'schemas', 'databases', 'catalogs', 'columns', 'partitions', 'tblproperties', 'views', 'create']), then: { create: new Set(['table', 'view']) } },
};
const SHOW = new Set(['show']);
/** `@@name` reads a server variable (MySQL, SQL Server): its configuration. */
const SERVER_VARIABLES = new Set(['mysql', 'mssql', 'fabric']);

/** The dotted names of a statement (`a.b.c`, quoted or not; a quoted part holding dots is read as several), each part as the names it can stand for. */
function nameChains(tokens: SqlToken[]): string[][][] {
  const chains: string[][][] = [];
  let current: string[][] | undefined;
  let afterDot = false;
  for (const token of tokens) {
    if (token.kind === 'word' || token.kind === 'quoted') {
      const parts = token.kind === 'quoted' ? token.text.split('.').map((part) => [part.toLowerCase()]) : [namesOf(token)];
      if (current && afterDot) current.push(...parts);
      else chains.push(current = [...parts]);
      afterDot = false;
    } else if (isPunct(token, '.') && current) {
      afterDot = true;
    } else {
      current = undefined;
      afterDot = false;
    }
  }
  return chains;
}

/** Why a statement a person or a model writes reaches the warehouse's own record of sessions, queries or settings, or null. */
function systemRelationRefusal(tokens: SqlToken[], driver: string): string | null {
  const rules = SYSTEM_RELATIONS[driver] ?? [];
  const partIs = (part: string[] | undefined, pattern: RegExp) => Boolean(part?.some((name) => pattern.test(name)));
  for (const chain of nameChains(tokens)) {
    for (const rule of rules) {
      for (let at = 0; at + rule.seq.length <= chain.length; at += 1) {
        if (!rule.seq.every((pattern, offset) => partIs(chain[at + offset], pattern))) continue;
        if (!rule.bare || at === 0 || partIs(chain[at - 1], SYSTEM_SCHEMAS)) return HOSTED_SYSTEM_RELATION_REFUSED;
      }
    }
  }
  const show = SHOW_ALLOWED[driver];
  for (const statement of show ? statementsOf(tokens) : []) {
    const words = statement.filter((token) => token.kind === 'word' || token.kind === 'quoted');
    if (!wordNamed(firstWord(words, false), SHOW)) continue;
    let at = 1;
    while (namesOf(words[at]).some((name) => show!.skip?.has(name))) at += 1;
    const what = namesOf(words[at]).find((name) => show!.words.has(name));
    if (!what) return HOSTED_SYSTEM_RELATION_REFUSED;
    const then = show!.then?.[what];
    if (then && !namesOf(words[at + 1]).some((name) => then.has(name))) return HOSTED_SYSTEM_RELATION_REFUSED;
  }
  if (SERVER_VARIABLES.has(driver)) {
    for (let index = 0; index + 1 < tokens.length; index += 1) {
      if (isPunct(tokens[index], '@') && isPunct(tokens[index + 1], '@') && tokens[index]!.end === tokens[index + 1]!.start) return HOSTED_SYSTEM_RELATION_REFUSED;
    }
  }
  return null;
}

/** A refused name (or reader), called anywhere in the text, strings and comments included, for the cross-check. */
function anyCallPattern(driver: string): RegExp {
  const own = ENGINE_FUNCTIONS[driver];
  return new RegExp(String.raw`(?<![A-Za-z0-9_$])(${READER_NAMES}|${REFUSED_FUNCTION_NAMES}${own ? `|${own}` : ''})\s*["\x60]?\s*\(`, 'gi');
}

/** The names a word token can stand for: as written, lower case, and any ASCII word a case fold or normalisation turns it into. */
function namesOf(token: SqlToken | undefined): string[] {
  if (!token || (token.kind !== 'word' && token.kind !== 'quoted')) return [];
  return [token.text.toLowerCase(), ...(token.folds ?? [])];
}
const isPunct = (token: SqlToken | undefined, text: string) => token?.kind === 'punct' && token.text === text;
const named = (token: SqlToken | undefined, set: Set<string> | RegExp): boolean => namesOf(token).some((name) => (set instanceof Set ? set.has(name) : set.test(name)));
const wordNamed = (token: SqlToken | undefined, set: Set<string> | RegExp): boolean => token?.kind === 'word' && named(token, set);

/** The real path of a folder (or its nearest existing ancestor and the rest), for comparing paths as the file system resolves them. */
function realPathOf(path: string): string {
  let current = resolve(path);
  const rest: string[] = [];
  for (;;) {
    if (existsSync(current)) {
      try {
        return resolve(realpathSync(current), ...rest);
      } catch {
        return resolve(current, ...rest);
      }
    }
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    rest.unshift(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    current = parent;
  }
}

/** Whether a literal path a statement reads is inside one of the allowed folders (globs only below the folder). */
function insideAllowed(path: string, allowed: readonly string[]): boolean {
  if (!path || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(path) || path.startsWith('~') || /[\u0000-\u001f]/.test(path)) return false;
  const globAt = path.search(/[*?[{]/);
  const fixed = globAt < 0 ? path : path.slice(0, globAt);
  // A glob's folder part must itself be fixed: `..` is never read through a pattern.
  if (path.split(/[\\/]/).some((part) => part === '..')) return false;
  const target = realPathOf(isAbsolute(fixed) ? fixed : resolve(process.cwd(), fixed || '.'));
  return allowed.some((folder) => {
    const base = realPathOf(folder);
    return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
  });
}

/** The statements of a token list, split at `;` (empty ones left out). */
function statementsOf(tokens: SqlToken[]): SqlToken[][] {
  const statements: SqlToken[][] = [[]];
  for (const token of tokens) {
    if (isPunct(token, ';')) statements.push([]);
    else statements[statements.length - 1]!.push(token);
  }
  return statements.filter((statement) => statement.length > 0);
}

/** The first word of a statement after its opening parentheses (and, with `prefixes`, after EXPLAIN and the like). */
function firstWord(statement: SqlToken[], prefixes: boolean): SqlToken | undefined {
  for (const token of statement) {
    if (isPunct(token, '(')) continue;
    if (prefixes && wordNamed(token, PREFIX_WORDS)) continue;
    return token;
  }
  return undefined;
}

/** Why a statement a person or a model writes is not a read, or null. */
function readOnlyRefusal(tokens: SqlToken[], driver: string): string | null {
  const statements = statementsOf(tokens);
  if (statements.length > 1) return HOSTED_READ_ONLY_REFUSED;
  const statement = statements[0] ?? [];
  if (!statement.length) return null;
  const first = firstWord(statement, false);
  if (!wordNamed(first, READ_STARTS)) return HOSTED_READ_ONLY_REFUSED;
  // EXPLAIN (ANALYZE) runs the statement it explains: that one must read too.
  if (wordNamed(first, EXPLAIN)) {
    const inner = statement.slice(statement.indexOf(first!) + 1).find((token) => token.kind === 'word' && (named(token, READ_STARTS) || named(token, WRITE_STARTS)) && !named(token, EXPLAIN_OPTIONS));
    if (!inner || !named(inner, READ_STARTS)) return HOSTED_READ_ONLY_REFUSED;
  }
  const duckdb = driver === 'duckdb' || driver === 'file';
  for (let index = 0; index < statement.length; index += 1) {
    const token = statement[index]!;
    if (token.kind !== 'word') continue;
    const previous = statement[index - 1];
    const next = statement[index + 1];
    // `t.update` is a column and `insert(...)` a function (MySQL, Snowflake): neither is a change.
    if (isPunct(previous, '.') || isPunct(next, '(')) {
      if (isPunct(next, '(') && named(token, EFFECT_FUNCTION)) return HOSTED_READ_ONLY_REFUSED;
      continue;
    }
    // A change can begin inside parentheses (a CTE body, a subquery).
    if (isPunct(previous, '(') && named(token, NESTED_WRITE_STARTS)) return HOSTED_READ_ONLY_REFUSED;
    if (named(token, WRITE_WORDS)) {
      // DuckDB's UNPIVOT ... INTO NAME n VALUE v names its output columns; it writes nothing.
      const unpivotInto = duckdb && named(token, INTO) && wordNamed(next, NAME) && statement.slice(0, index).some((item) => wordNamed(item, UNPIVOT));
      // SHOW CREATE TABLE prints a table's definition; it makes nothing.
      const showCreate = previous === first && wordNamed(first, SHOW) && named(token, CREATE);
      if (!unpivotInto && !showCreate) return HOSTED_READ_ONLY_REFUSED;
    }
    // Row locks: FOR SHARE, FOR KEY SHARE (FOR UPDATE is caught above), MySQL's LOCK IN SHARE MODE.
    if (named(token, SHARE) && wordNamed(previous, FOR_OR_KEY)) return HOSTED_READ_ONLY_REFUSED;
    if (driver === 'mysql' && named(token, LOCK) && wordNamed(next, IN)) return HOSTED_READ_ONLY_REFUSED;
  }
  return null;
}

export interface HostedStatementOptions {
  /**
   * The statement comes from a person or a model (purpose other than `platform`): it may only read, one
   * statement at a time.
   */
  readOnly?: boolean;
}

/**
 * Why DQL refuses this statement on a host's connection, or null. Plain text
 * for the person; nothing from the statement is repeated.
 */
export function hostedStatementRefusal(sql: string, driver: string, allowedDirectories: readonly string[] = [], options: HostedStatementOptions = {}): string | null {
  if (/\bU&["']/i.test(sql)) return HOSTED_STATEMENT_REFUSED;
  let tokens: SqlToken[];
  try {
    tokens = lexStatement(sql, driver);
  } catch {
    return HOSTED_STATEMENT_UNREADABLE;
  }
  const allowed = allowedDirectories.filter((folder) => typeof folder === 'string' && folder.trim() !== '');
  const duckdb = driver === 'duckdb' || driver === 'file';
  const engineFunction = ENGINE_FUNCTIONS[driver] ? new RegExp(`^(?:${ENGINE_FUNCTIONS[driver]})$`) : undefined;

  // Statements: the first word of each (after EXPLAIN [ANALYZE] and opening parentheses).
  for (const statement of statementsOf(tokens)) {
    if (wordNamed(firstWord(statement, true), REFUSED_STATEMENTS)) return HOSTED_STATEMENT_REFUSED;
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    // MySQL writes files from a SELECT.
    if (named(token, INTO) && named(tokens[index + 1], OUTFILE)) return HOSTED_STATEMENT_REFUSED;
    // Snowflake reads a stage (`@stage`, `@~`, `@%table`).
    if (driver === 'snowflake' && isPunct(token, '@')) return HOSTED_STATEMENT_REFUSED;
    // Spark reads a file as a table named by its path (csv.`/data/x.csv`).
    if (driver === 'databricks' && token.kind === 'word' && named(token, PATH_TABLE_FORMATS) && isPunct(tokens[index + 1], '.') && tokens[index + 2]?.kind === 'quoted') return HOSTED_STATEMENT_REFUSED;
  }

  // Function calls: a name (plain or quoted, qualified or not) followed by `(`.
  let readerCalls = 0;
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const token = tokens[index]!;
    if ((token.kind !== 'word' && token.kind !== 'quoted') || !isPunct(tokens[index + 1], '(')) continue;
    if (named(token, REFUSED_FUNCTION) || (engineFunction && named(token, engineFunction))) return HOSTED_STATEMENT_REFUSED;
    if (driver === 'bigquery' && isPunct(tokens[index - 1], '.') && named(tokens[index - 2], BIGQUERY_PREFIXES)) return HOSTED_STATEMENT_REFUSED;
    if (!named(token, FILE_READER)) continue;
    if (!allowed.length) return HOSTED_STATEMENT_REFUSED;
    // In an allowed folder: the first argument is a plain path, or a list of plain paths.
    const paths: string[] = [];
    let at = index + 2;
    if (tokens[at]?.kind === 'string') {
      paths.push(tokens[at]!.text);
      at += 1;
    } else if (isPunct(tokens[at], '[')) {
      at += 1;
      while (tokens[at]?.kind === 'string') {
        paths.push(tokens[at]!.text);
        at += 1;
        if (isPunct(tokens[at], ',')) at += 1;
      }
      if (!isPunct(tokens[at], ']')) return HOSTED_STATEMENT_REFUSED;
      at += 1;
    }
    if (!paths.length || !(isPunct(tokens[at], ',') || isPunct(tokens[at], ')'))) return HOSTED_STATEMENT_REFUSED;
    if (!paths.every((path) => insideAllowed(path, allowed))) return HOSTED_STATEMENT_REFUSED;
    readerCalls += 1;
  }
  // The same names anywhere in the text, strings and comments included: a call the token scan did not see
  // as one (a disagreement about where a string or comment ends) is refused rather than trusted.
  const textCalls = [...sql.matchAll(anyCallPattern(driver))].length;
  if (textCalls > readerCalls) return HOSTED_STATEMENT_REFUSED;

  // DuckDB reads a string (or a quoted name that looks like a file) in FROM as a file: a replacement scan.
  if (duckdb) {
    let depth = 0;
    const fromAt: number[] = [];
    let previous: SqlToken | undefined;
    for (const token of tokens) {
      if (isPunct(token, '(')) depth += 1;
      if (isPunct(token, ')')) {
        while (fromAt.length && fromAt[fromAt.length - 1]! >= depth) fromAt.pop();
        depth -= 1;
      }
      if (isPunct(token, ';')) { fromAt.length = 0; depth = 0; }
      if (wordNamed(token, FROM)) fromAt.push(depth);
      else if (token.kind === 'word' && named(token, AFTER_FROM) && fromAt[fromAt.length - 1] === depth) fromAt.pop();
      const inFrom = fromAt[fromAt.length - 1] === depth;
      const afterItemStart = previous && (wordNamed(previous, FROM_OR_JOIN) || (inFrom && isPunct(previous, ',')));
      if (afterItemStart && (token.kind === 'string' || (token.kind === 'quoted' && /[./\\:*?]/.test(token.text)))) {
        if (!allowed.length || !insideAllowed(token.text, allowed)) return HOSTED_STATEMENT_REFUSED;
      }
      previous = token;
    }
  }

  if (!options.readOnly) return null;
  return readOnlyRefusal(tokens, driver) ?? systemRelationRefusal(tokens, driver);
}
