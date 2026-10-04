import { describe, expect, it } from 'vitest';
import { HOSTED_READ_ONLY_REFUSED, HOSTED_STATEMENT_REFUSED, HOSTED_STATEMENT_UNREADABLE, HOSTED_SYSTEM_RELATION_REFUSED, hostedStatementRefusal } from './engine-guard.js';
import { lexStatement } from './sql-lexicon.js';
import { queryHistorySql } from '../warehouse-model-discovery.js';

/**
 * RFC 0010, with a host: the statement check reads a statement the way its engine reads it, and refuses what it
 * cannot decide. Each entry is one statement on one engine: what the check must refuse, and ordinary questions it
 * must let through. The first group is checked as DQL's own statements (`platform`), the read-only group as
 * statements a person or a model writes.
 */
const char = (code: number) => String.fromCharCode(code);
const NBSP = char(0xa0);
const ZERO_WIDTH = char(0x200b);
const DOTLESS_I = char(0x131);
const LONG_S = char(0x17f);
const FULLWIDTH_S = char(0xff33);
const FULLWIDTH_SEMICOLON = char(0xff1b);
const LINE_SEPARATOR = char(0x2028);

type Entry = [driver: string, sql: string];

/** Reaches beyond the tables, or cannot be read the one way the engine reads it: refused for anyone. */
const MUST_REFUSE: Entry[] = [
  // A comment ends where the engine ends it: Postgres and DuckDB end `--` at a carriage return.
  ['duckdb', "SELECT 1 AS a -- note\r, getenv('HOME') AS h"],
  ['postgresql', "SELECT 1 AS a -- note\r, pg_read_file('/etc/passwd') AS f"],
  ['sqlite', "SELECT 1 AS a -- note\r'\n, 2 AS b -- '"],
  // Nested block comments: some engines nest, some do not.
  ['postgresql', "SELECT 1 /* a /* b */ ' */ , pg_read_file('/etc/passwd') -- '"],
  ['duckdb', 'SELECT 1 /* outer /* inner */ still a comment here */ AS a'],
  ['mssql', 'SELECT 1 /* a /* b */ c */ AS a'],
  // Backslash escapes: Snowflake reads them in strings; MySQL and Spark depend on a setting DQL cannot see.
  ['snowflake', "SELECT 'a\\' , system$whitelist() , '' AS b"],
  ['mysql', "SELECT 'a\\' , 1 INTO OUTFILE '/tmp/x' -- '"],
  ['mysql', 'SELECT "a\\" , 1 AS b -- "'],
  ['databricks', "SELECT 'a\\' , 1 AS b -- '"],
  ['postgresql', "SELECT 'a\\' , 1 AS b -- '"],
  ['bigquery', "SELECT 'a\\' , EXTERNAL_QUERY('c', 'SELECT 1') , '' AS b"],
  // Triple-quoted and raw strings (BigQuery, Spark).
  ['bigquery', "SELECT '''a'b''' , EXTERNAL_QUERY('c', 'q') AS x"],
  ['databricks', "SELECT r'\\' , reflect('java.lang.Runtime', 'getRuntime') , '' AS b"],
  // MySQL comments and executable comments.
  ['mysql', 'SELECT 1 /*! , LOAD_FILE(0x2f) */ AS a'],
  ['mysql', 'SELECT 1 /*M! , LOAD_FILE(0x2f) */ AS a'],
  ['mysql', "SELECT 1 # '\n, LOAD_FILE('/etc/passwd') AS f -- '"],
  // Quoted names: SQLite's [name] and backticks, BigQuery's backticks with escapes.
  ['sqlite', "SELECT [a'] , load_extension('/tmp/x') , [']"],
  ['sqlite', "SELECT 1 AS [a'b], readfile('/etc/passwd') AS f"],
  // Dollar strings only where the engine has them: in MySQL and SQLite `$$` is a name or a parameter.
  ['postgresql', "SELECT $x$ ' $x$ , pg_read_file('/etc/passwd') AS f"],
  // `//` is a comment in Snowflake.
  ['snowflake', "SELECT 1 // '\n, system$get_privatelink_config() AS c -- '"],
  // Characters outside text that engines read differently, and signs that normalise to others.
  ['duckdb', `SELECT${NBSP}1 AS a`],
  ['postgresql', `SELECT 1 AS a${ZERO_WIDTH}`],
  ['duckdb', `SELECT 1 AS a${FULLWIDTH_SEMICOLON} SELECT 2`],
  ['duckdb', `SELECT 1 AS a -- note${LINE_SEPARATOR}, getenv('HOME')`],
  ['duckdb', `SELECT 1 AS a${char(0)}`],
  ['clickhouse', 'SELECT 1 # comment\n AS a'],
  // Per-engine families: files, stages, URLs, other servers, procedures, secrets, other statements' results.
  ['snowflake', 'SELECT $1 FROM @my_stage'],
  ['snowflake', "SELECT * FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))"],
  ['snowflake', "SELECT * FROM TABLE(INFER_SCHEMA(LOCATION => 'x'))"],
  ['snowflake', "SELECT GET_PRESIGNED_URL('x', 'y') AS u"],
  ['snowflake', 'LIST @my_stage'],
  ['snowflake', 'REMOVE @my_stage'],
  ['snowflake', "CALL my_procedure()"],
  ['snowflake', "EXECUTE IMMEDIATE 'SELECT 1'"],
  ['databricks', 'SELECT * FROM csv.`/mnt/data/members.csv`'],
  ['databricks', "SELECT * FROM read_files('/mnt/data')"],
  ['databricks', "SELECT secret('scope', 'key') AS s"],
  ['databricks', "SELECT java_method('java.lang.System', 'getenv', 'HOME') AS h"],
  ['databricks', "SELECT ai_query('endpoint', 'text') AS a"],
  ['databricks', 'ADD JAR /tmp/x.jar'],
  ['bigquery', "SELECT * FROM EXTERNAL_QUERY('conn', 'SELECT * FROM t')"],
  ['bigquery', 'SELECT * FROM ML.PREDICT(MODEL m, TABLE t)'],
  ['bigquery', 'SELECT OBJ.GET_ACCESS_URL(ref, \'r\') FROM t'],
  ['postgresql', "SELECT query_to_xml('SELECT * FROM members', true, true, '') AS x"],
  ['postgresql', "SELECT set_config('role', 'admin', false) AS s"],
  ['postgresql', "SELECT pg_terminate_backend(1) AS t"],
  ['postgresql', "SELECT lo_get(1) AS l"],
  ['redshift', "UNLOAD ('SELECT 1') TO 's3://bucket/x'"],
  ['mysql', "SELECT sys_exec('id') AS s"],
  ['mysql', "SELECT GET_LOCK('x', 1) AS l"],
  ['sqlite', "SELECT * FROM fsdir('/etc')"],
  ['sqlite', "SELECT writefile('/tmp/x', 'y') AS w"],
  ['mssql', "SELECT * FROM OPENROWSET(BULK '/etc/passwd', SINGLE_CLOB) AS x"],
  ['mssql', "EXEC xp_cmdshell 'dir'"],
  ['fabric', "SELECT * FROM OPENROWSET(BULK 'https://x/y.csv') AS x"],
  ['clickhouse', "SELECT * FROM file('/etc/passwd', 'LineAsString')"],
  ['clickhouse', "SELECT * FROM url('http://169.254.169.254/latest', CSV)"],
  ['clickhouse', "SELECT * FROM s3('https://bucket/x.csv')"],
  ['clickhouse', "SELECT * FROM remote('other:9000', db.t)"],
  ['duckdb', 'SELECT * FROM duckdb_secrets()'],
  // Table functions over other sessions' queries, and the server's files: refused for anyone.
  ['snowflake', 'SELECT * FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY_BY_USER())'],
  ['snowflake', 'SELECT * FROM TABLE(information_schema.login_history())'],
  ['postgresql', "SELECT pg_read_binary_file('postgresql.conf')"],
  ['postgresql', "SELECT * FROM pg_ls_dir('.')"],
  ['trino', "SELECT 1 AS a; SET SESSION x = 1"],
  ['athena', 'SELECT `a` FROM t -- `'],
  // An engine DQL does not know how to read.
  ['oracle', 'SELECT 1 FROM dual'],
];

/** Ordinary questions over tables and views, on each engine. */
const MUST_ALLOW: Entry[] = [
  ['duckdb', "SELECT region, COUNT(*) AS n FROM main.claims WHERE status = 'open' GROUP BY region ORDER BY region"],
  ['duckdb', "SELECT E'a\\'b' AS v, $$it's$$ AS w, $t$x$t$ AS y FROM claims"],
  ['duckdb', "SELECT 1 AS a -- a comment\r\n, 2 AS b"],
  ['postgresql', "SELECT region, SUM(amount) AS total FROM public.claims WHERE note = 'it''s' GROUP BY region"],
  ['postgresql', 'SELECT region, 5 # 3 AS x FROM claims'],
  ['redshift', "SELECT region FROM claims WHERE note LIKE 'a%' ESCAPE '!'"],
  ['snowflake', "SELECT \"REGION\", COUNT(*) FROM \"DB\".\"PUBLIC\".\"CLAIMS\" WHERE note = 'it\\'s' GROUP BY 1"],
  ['snowflake', 'SELECT $$a string$$ AS s, $1 FROM claims'],
  ['snowflake', 'SHOW COLUMNS IN claims'],
  ['bigquery', "SELECT region, COUNT(*) FROM `project.dataset.claims` WHERE note = \"it's\" AND x = r'\\d+' GROUP BY region"],
  ['bigquery', "SELECT '''multi\nline''' AS s # a comment\n FROM t"],
  ['mysql', 'SELECT `region`, COUNT(*) FROM claims WHERE note = \'x\' GROUP BY `region` -- note'],
  ['mysql', 'SELECT 1--1 AS a FROM claims'],
  ['sqlite', 'SELECT [region], `amount`, "status" FROM claims'],
  ['sqlite', "SELECT name, type FROM pragma_table_info('claims')"],
  ['mssql', 'SELECT TOP 10 [region], COUNT(*) AS n FROM dbo.claims GROUP BY [region]'],
  ['clickhouse', "SELECT region, count() FROM claims WHERE note = 'it\\'s' GROUP BY region"],
  ['databricks', "SELECT region, count(*) FROM main.claims WHERE note = 'x' GROUP BY region"],
  ['trino', "SELECT region FROM hive.default.claims WHERE note = 'it''s'"],
  ['athena', "SELECT region FROM claims WHERE note = 'x'"],
];

/** Statements a person or a model writes: a change, a session or locking statement, or several at once. */
const MUST_REFUSE_AS_READ: Entry[] = [
  ['duckdb', 'INSERT INTO claims VALUES (1)'],
  ['duckdb', 'CREATE TABLE copy_of_claims AS SELECT * FROM claims'],
  ['duckdb', 'CREATE OR REPLACE VIEW v AS SELECT 1'],
  ['duckdb', 'DROP TABLE claims'],
  ['duckdb', 'UPDATE claims SET amount = 0'],
  ['duckdb', 'DELETE FROM claims'],
  ['duckdb', 'TRUNCATE claims'],
  ['duckdb', 'WITH x AS (SELECT 1) INSERT INTO claims SELECT * FROM x'],
  ['duckdb', 'FROM claims INSERT INTO claims'],
  ['duckdb', "SELECT nextval('seq') AS n"],
  ['duckdb', 'CHECKPOINT'],
  ['duckdb', 'SELECT 1; SELECT 2'],
  ['duckdb', 'EXPLAIN ANALYZE DELETE FROM claims'],
  ['postgresql', 'SELECT * INTO TEMP copy FROM claims'],
  ['postgresql', 'SELECT * FROM claims FOR UPDATE'],
  ['postgresql', 'SELECT * FROM claims FOR SHARE'],
  ['postgresql', 'WITH gone AS (DELETE FROM claims RETURNING *) SELECT * FROM gone'],
  ['postgresql', 'BEGIN'],
  ['postgresql', 'GRANT SELECT ON claims TO PUBLIC'],
  ['postgresql', 'VACUUM claims'],
  ['snowflake', 'MERGE INTO claims USING x ON claims.id = x.id WHEN MATCHED THEN DELETE'],
  ['snowflake', 'ALTER SESSION SET QUERY_TAG = 1'],
  ['snowflake', 'UNDROP TABLE claims'],
  ['snowflake', 'COMMENT ON TABLE claims IS \'x\''],
  ['bigquery', 'DECLARE x INT64'],
  ['bigquery', 'CREATE TEMP FUNCTION f() AS (1)'],
  ['mysql', 'REPLACE INTO claims VALUES (1)'],
  ['mysql', 'SELECT * FROM claims LOCK IN SHARE MODE'],
  ['mysql', 'HANDLER claims OPEN'],
  ['mysql', 'DO SLEEP(1)'],
  ['databricks', 'OPTIMIZE claims'],
  ['databricks', 'REFRESH TABLE claims'],
  ['databricks', 'CACHE TABLE claims'],
  ['mssql', 'SELECT * INTO #copy FROM claims'],
  ['sqlite', 'REINDEX claims'],
  ['clickhouse', 'OPTIMIZE TABLE claims FINAL'],
  ['trino', 'CALL system.sync_partition_metadata(\'a\', \'b\', \'FULL\')'],
  // A word that a case fold or normalisation turns into a change.
  ['duckdb', `${DOTLESS_I}NSERT INTO claims VALUES (1)`],
  ['databricks', `${DOTLESS_I}NSERT INTO claims VALUES (1)`],
  ['duckdb', `SELECT 1; ${FULLWIDTH_S}ELECT 2`],
  ['snowflake', `${LONG_S}ELECT 1; DROP TABLE claims`],
];

/** Statements a person or a model writes that read: allowed. */
const MUST_ALLOW_AS_READ: Entry[] = [
  ['duckdb', "SELECT region, COUNT(*) AS n FROM claims GROUP BY region"],
  ['duckdb', 'WITH recent AS (SELECT * FROM claims WHERE amount > 10) SELECT COUNT(*) FROM recent'],
  ['duckdb', 'VALUES (1), (2)'],
  ['duckdb', 'TABLE claims'],
  ['duckdb', 'FROM claims SELECT region'],
  ['duckdb', 'DESCRIBE claims'],
  ['duckdb', 'SUMMARIZE claims'],
  ['duckdb', 'SHOW TABLES'],
  ['duckdb', 'EXPLAIN ANALYZE SELECT * FROM claims'],
  ['duckdb', 'PIVOT claims ON region USING SUM(amount)'],
  ['duckdb', 'UNPIVOT claims ON a, b INTO NAME k VALUE v'],
  ['duckdb', 'SELECT * FROM claims;'],
  ['duckdb', '(SELECT 1) UNION ALL (SELECT 2)'],
  ['duckdb', 'SELECT t.update, t.delete FROM claims AS t'],
  ['duckdb', 'SELECT MAX(start_date) AS s, COUNT(comment) AS c FROM claims'],
  ['postgresql', "EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM claims"],
  ['postgresql', 'SELECT SUBSTRING(note FROM 1 FOR 3) FROM claims'],
  ['mysql', "SELECT INSERT('abcdef', 2, 3, 'x') AS s, TRUNCATE(1.234, 1) AS t FROM claims"],
  ['snowflake', "SELECT INSERT('abc', 1, 1, 'x') AS s FROM claims"],
  ['snowflake', 'SHOW TABLES IN SCHEMA public'],
  ['snowflake', 'DESCRIBE TABLE claims'],
  ['bigquery', 'SELECT * FROM `p.d.claims` FOR SYSTEM_TIME AS OF CURRENT_TIMESTAMP()'],
  ['databricks', 'DESCRIBE TABLE claims'],
  ['clickhouse', 'SELECT region FROM claims'],
  ['trino', 'SHOW COLUMNS FROM claims'],
];

/**
 * Statements a person or a model writes that read the warehouse's own record of other sessions, their queries, its
 * users or its settings: refused, however the name is written (case, quotes, qualification).
 */
const MUST_REFUSE_SYSTEM: Entry[] = [
  ['snowflake', 'SELECT query_text FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY'],
  ['snowflake', 'SELECT * FROM "SNOWFLAKE"."ACCOUNT_USAGE"."LOGIN_HISTORY"'],
  ['snowflake', 'SELECT * FROM account_usage.sessions'],
  ['snowflake', 'SELECT * FROM snowflake.account_usage.access_history WHERE 1 = 1'],
  ['snowflake', 'SHOW PARAMETERS'],
  ['snowflake', 'SHOW USERS'],
  ['snowflake', 'SHOW GRANTS TO ROLE analyst'],
  ['databricks', 'SELECT statement_text FROM system.query.history'],
  ['databricks', 'SELECT * FROM `system`.`access`.`audit`'],
  ['databricks', 'SELECT * FROM SYSTEM.BILLING.USAGE'],
  ['databricks', 'SHOW GRANTS ON TABLE claims'],
  ['bigquery', 'SELECT query FROM `region-us`.INFORMATION_SCHEMA.JOBS'],
  ['bigquery', 'SELECT * FROM `my-project.region-us.INFORMATION_SCHEMA.JOBS_BY_USER`'],
  ['bigquery', 'SELECT * FROM `p`.`region-eu`.`information_schema`.`SESSIONS_BY_PROJECT`'],
  ['bigquery', 'SELECT * FROM region-us.INFORMATION_SCHEMA.JOBS_TIMELINE'],
  ['postgresql', 'SELECT query FROM pg_stat_activity'],
  ['postgresql', 'SELECT * FROM pg_catalog.pg_settings'],
  ['postgresql', 'SELECT query FROM "pg_stat_statements"'],
  ['postgresql', 'SELECT c.region FROM claims AS c JOIN PG_STAT_ACTIVITY AS a ON true'],
  ['postgresql', 'SELECT (SELECT count(*) FROM pg_locks) AS n'],
  ['postgresql', "SELECT current_setting('data_directory')"],
  ['postgresql', "SELECT current_setting('search_path') AS p, 5 # 3 AS x"],
  ['postgresql', 'SHOW data_directory'],
  ['postgresql', 'SHOW ALL'],
  ['redshift', 'SELECT querytxt FROM stl_query'],
  ['redshift', 'SELECT * FROM pg_catalog.svl_statementtext'],
  ['redshift', 'SELECT * FROM sys_query_history'],
  ['redshift', 'SELECT * FROM STV_RECENTS'],
  ['redshift', 'SHOW search_path'],
  ['mysql', 'SELECT * FROM performance_schema.events_statements_current'],
  ['mysql', 'SELECT * FROM `performance_schema`.`threads`'],
  ['mysql', 'SELECT * FROM information_schema.PROCESSLIST'],
  ['mysql', 'SELECT user, host FROM mysql.user'],
  ['mysql', 'SELECT * FROM sys.session'],
  ['mysql', 'SHOW FULL PROCESSLIST'],
  ['mysql', 'SHOW GLOBAL VARIABLES'],
  ['mysql', 'SHOW GRANTS'],
  ['mysql', 'SELECT @@datadir'],
  ['mysql', 'SELECT @@global.secure_file_priv AS p'],
  ['duckdb', 'SELECT * FROM duckdb_settings()'],
  ['duckdb', 'SELECT * FROM "duckdb_settings"()'],
  ['duckdb', 'SELECT * FROM duckdb_extensions()'],
  ['duckdb', 'SELECT * FROM pg_catalog.pg_settings'],
  ['duckdb', 'SELECT * FROM duckdb_databases'],
  ['duckdb', "SELECT current_setting('home_directory')"],
  ['clickhouse', 'SELECT query FROM system.query_log'],
  ['clickhouse', 'SELECT * FROM `system`.`processes`'],
  ['clickhouse', 'SHOW PROCESSLIST'],
  ['clickhouse', "SHOW SETTINGS LIKE '%path%'"],
  ['trino', 'SELECT * FROM system.runtime.queries'],
  ['athena', 'SELECT * FROM system.runtime.nodes'],
  ['mssql', 'SELECT * FROM sys.dm_exec_sessions'],
  ['mssql', 'SELECT * FROM [sys].[configurations]'],
  ['mssql', 'SELECT @@SERVERNAME AS s'],
  ['fabric', 'SELECT * FROM sys.dm_exec_requests'],
];

/** Look-alikes of those: a team's own tables and columns with similar names, catalog lookups DQL itself makes. Allowed. */
const MUST_ALLOW_NOT_SYSTEM: Entry[] = [
  ['snowflake', 'SELECT * FROM sessions'],
  ['snowflake', 'SELECT session_id, query_history FROM analytics.web_sessions'],
  ['snowflake', 'SHOW TERSE SCHEMAS IN ACCOUNT LIMIT 100'],
  ['snowflake', 'SHOW EXTERNAL TABLES'],
  ['snowflake', 'SHOW PRIMARY KEYS IN DATABASE analytics'],
  ['snowflake', 'SELECT column_name FROM analytics.information_schema.columns'],
  ['databricks', 'SELECT * FROM billing.invoices'],
  ['databricks', 'SELECT * FROM main.access.badges'],
  ['databricks', 'SHOW TABLES IN main.claims'],
  ['databricks', 'SHOW CATALOGS'],
  ['bigquery', 'SELECT * FROM `p.d.jobs`'],
  ['bigquery', 'SELECT column_name FROM `p.d`.INFORMATION_SCHEMA.COLUMNS'],
  ['postgresql', 'SELECT * FROM ops.pg_locks'],
  ['postgresql', "SELECT * FROM claims WHERE note = 'pg_stat_activity'"],
  ['postgresql', 'SELECT column_name FROM information_schema.columns WHERE table_name = $1'],
  ['redshift', 'SELECT c.stl_weight FROM claims AS c'],
  ['redshift', 'SHOW TABLES FROM SCHEMA dev.public'],
  ['mysql', 'SHOW TABLES'],
  ['mysql', 'SHOW FULL COLUMNS FROM claims'],
  ['mysql', 'SHOW CREATE TABLE claims'],
  ['databricks', 'SHOW CREATE TABLE claims'],
  ['mysql', "SELECT * FROM claims WHERE email LIKE '%@@%'"],
  ['mysql', 'SELECT table_name FROM information_schema.tables'],
  ['clickhouse', 'SELECT name, type FROM system.columns WHERE database = ? AND table = ?'],
  ['clickhouse', 'SHOW TABLES'],
  ['duckdb', 'SELECT * FROM settings'],
  ['trino', 'SELECT * FROM hive.runtime_stats.queries'],
  ['mssql', 'SELECT * FROM dbo.sessions'],
];

describe('the statement check reads each engine\'s way (with a host)', () => {
  it.each(MUST_REFUSE)('%s: refused (entry %#)', (driver, sql) => {
    const refusal = hostedStatementRefusal(sql, driver, [], { readOnly: false });
    expect([HOSTED_STATEMENT_REFUSED, HOSTED_STATEMENT_UNREADABLE], sql).toContain(refusal);
  });

  it.each(MUST_ALLOW)('%s: an ordinary question runs (entry %#)', (driver, sql) => {
    expect(hostedStatementRefusal(sql, driver, [], { readOnly: true }), sql).toBeNull();
  });

  it.each(MUST_REFUSE_AS_READ)('%s: not a read, refused for a person (entry %#)', (driver, sql) => {
    expect(hostedStatementRefusal(sql, driver, [], { readOnly: true }), sql).not.toBeNull();
  });

  it.each(MUST_ALLOW_AS_READ)('%s: a read, runs for a person (entry %#)', (driver, sql) => {
    expect(hostedStatementRefusal(sql, driver, [], { readOnly: true }), sql).toBeNull();
  });

  it.each(MUST_REFUSE_SYSTEM)('%s: the warehouse\'s own record, refused for a person (entry %#)', (driver, sql) => {
    expect(hostedStatementRefusal(sql, driver, [], { readOnly: true }), sql).toBe(HOSTED_SYSTEM_RELATION_REFUSED);
  });

  it.each(MUST_ALLOW_NOT_SYSTEM)('%s: a look-alike of the warehouse\'s own record, runs (entry %#)', (driver, sql) => {
    expect(hostedStatementRefusal(sql, driver, [], { readOnly: true }), sql).toBeNull();
  });

  it('refuses warehouse discovery\'s own query-history read for a person, on every engine that keeps one', () => {
    for (const driver of ['snowflake', 'postgresql', 'databricks', 'bigquery']) {
      const sql = queryHistorySql(driver, { database: 'analytics', location: 'US' });
      expect(sql, driver).toBeDefined();
      expect(hostedStatementRefusal(sql!, driver, [], { readOnly: true }), driver).not.toBeNull();
    }
  });

  it('says why in plain words and repeats nothing from the statement', () => {
    expect(hostedStatementRefusal('DELETE FROM claims WHERE note = \'CANARY-STMT-1\'', 'duckdb', [], { readOnly: true })).toBe(HOSTED_READ_ONLY_REFUSED);
    expect(hostedStatementRefusal('SELECT query FROM pg_stat_activity WHERE query LIKE \'%CANARY-STMT-2%\'', 'postgresql', [], { readOnly: true })).toBe(HOSTED_SYSTEM_RELATION_REFUSED);
    for (const refusal of [HOSTED_READ_ONLY_REFUSED, HOSTED_STATEMENT_REFUSED, HOSTED_STATEMENT_UNREADABLE, HOSTED_SYSTEM_RELATION_REFUSED]) expect(refusal).not.toMatch(/CANARY|pg_stat/);
  });

  it('lets DQL\'s own statements keep their shapes (platform), and still refuses what reaches beyond the tables for them', () => {
    expect(hostedStatementRefusal('CREATE OR REPLACE VIEW "regions" AS SELECT * FROM claims', 'duckdb', [], { readOnly: false })).toBeNull();
    expect(hostedStatementRefusal("CREATE OR REPLACE VIEW \"regions\" AS SELECT * FROM read_csv_auto('/etc/hosts')", 'duckdb', [], { readOnly: false })).toBe(HOSTED_STATEMENT_REFUSED);
    expect(hostedStatementRefusal('COPY claims TO \'/tmp/x.csv\'', 'duckdb', [], { readOnly: false })).toBe(HOSTED_STATEMENT_REFUSED);
  });

  it('reads a word that folds into a keyword as that keyword too', () => {
    const [word] = lexStatement(`${DOTLESS_I}NSERT`, 'duckdb');
    expect(word!.folds).toContain('insert');
    expect(lexStatement('stra' + char(0xdf) + 'e', 'duckdb')[0]!.folds).toEqual(['strasse']);
  });
});
