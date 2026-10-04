/**
 * HOW EACH ENGINE READS A STATEMENT (RFC 0010, with a host). The statement
 * check (engine-guard.ts) decides from tokens; a token scan that ends a
 * string, a quoted name or a comment somewhere the engine does not would let
 * the engine run text the check never looked at. So the scan follows each
 * engine's own rules for strings (backslash escapes, doubled quotes, `$$` and
 * `$tag$` strings, triple quotes, raw and escape prefixes), quoted names
 * (double quotes, backticks, brackets) and comments (`--`, `#`, `//`, block
 * comments, executable comments).
 *
 * Where an engine's reading depends on a setting DQL cannot see (MySQL's
 * NO_BACKSLASH_ESCAPES and ANSI_QUOTES, Postgres's standard_conforming_strings,
 * Spark's escapedStringLiterals), the statement is read every way the engine
 * could read it, and it is checked only when every reading agrees. Anything
 * the scan cannot decide is refused (fail closed): an unterminated string or
 * comment, a nested or executable comment, a line comment with a line break
 * other than its own, or a character outside text that some engines take for
 * a space and others for part of a name. A word that a case fold or Unicode
 * normalisation turns into an ASCII word carries that word too (`folds`), and
 * the check reads both.
 */

export type SqlTokenKind = 'word' | 'string' | 'quoted' | 'punct' | 'number';

export interface SqlToken {
  kind: SqlTokenKind;
  /** A word or punctuation as written; a string's or quoted name's content. */
  text: string;
  start: number;
  end: number;
  /**
   * A word with letters outside ASCII that a case fold or Unicode normalisation turns into an ASCII word
   * (a dotless i, a long s, full-width letters): that word too, lower case, so a check reads it both ways.
   */
  folds?: string[];
}

export class UnreadableStatement extends Error {}

/** A choice an engine makes by a setting DQL cannot see: both readings must agree. */
type Choice = boolean | 'either';

interface Lexicon {
  /** Backslash escapes in '...' strings. */
  backslash: Choice;
  /** A doubled quote inside a string or quoted name stands for one quote. */
  doubled: boolean;
  /** What "..." is. */
  doubleQuote: 'identifier' | 'string';
  /** Backslash escapes in "...". */
  doubleQuoteBackslash: Choice;
  /** Backticks quote a name. */
  backtick: Choice;
  /** Backslash escapes in `...`. */
  backtickBackslash: Choice;
  /** [name] quotes a name. */
  brackets: boolean;
  /** `$$...$$` (plain) and `$tag$...$tag$` (tagged) strings. */
  dollar: 'none' | 'plain' | 'tagged' | 'either';
  /** `#` starts a line comment. */
  hash: Choice;
  /** `//` starts a line comment. */
  slash: boolean;
  /** `--` starts a comment only before a space or a control character (MySQL). */
  dashNeedsSpace: boolean;
  /** `/*!` and `/*M!` comments run as code (MySQL, MariaDB): refused. */
  executableComments: boolean;
  /** '''...''' and """...""" strings (BigQuery). */
  tripleQuotes: boolean;
  /** r'...' strings without escapes (BigQuery, Spark). */
  rawStrings: boolean;
  /** E'...' strings with backslash escapes (Postgres, DuckDB, Redshift). */
  escapeStrings: boolean;
}

const BASE: Lexicon = {
  backslash: false,
  doubled: true,
  doubleQuote: 'identifier',
  doubleQuoteBackslash: false,
  backtick: false,
  backtickBackslash: false,
  brackets: false,
  dollar: 'none',
  hash: false,
  slash: false,
  dashNeedsSpace: false,
  executableComments: false,
  tripleQuotes: false,
  rawStrings: false,
  escapeStrings: false,
};

/**
 * Each engine DQL connects to, as its documentation (and, for DuckDB, SQLite
 * and Postgres, the engine itself) reads a statement.
 */
const LEXICONS: Record<string, Lexicon> = {
  // DuckDB: '' doubling, E'' escapes, "names", $$ and $tag$ strings; no backticks, `#` or `//` comments.
  duckdb: { ...BASE, escapeStrings: true, dollar: 'tagged' },
  file: { ...BASE, escapeStrings: true, dollar: 'tagged' },
  // Postgres: as DuckDB; plain strings read backslashes when standard_conforming_strings is off.
  postgresql: { ...BASE, backslash: 'either', escapeStrings: true, dollar: 'tagged' },
  // Redshift: a Postgres 8 parser; backslashes and dollar strings as it is set up.
  redshift: { ...BASE, backslash: 'either', escapeStrings: true, dollar: 'either' },
  // Snowflake: backslash escapes and '' in strings, $$ strings, `//` comments, "names".
  snowflake: { ...BASE, backslash: true, dollar: 'plain', slash: true },
  // BigQuery: '...' and "..." are strings with backslash escapes, no doubling; triple quotes; r'' raw; `names` with escapes; `#` comments.
  bigquery: { ...BASE, backslash: true, doubled: false, doubleQuote: 'string', doubleQuoteBackslash: true, backtick: true, backtickBackslash: true, tripleQuotes: true, rawStrings: true, hash: true },
  // MySQL / MariaDB: backslashes unless NO_BACKSLASH_ESCAPES; "..." a string unless ANSI_QUOTES; `names`; `#` and `-- ` comments; executable comments.
  mysql: { ...BASE, backslash: 'either', doubleQuote: 'string', doubleQuoteBackslash: 'either', backtick: true, hash: true, dashNeedsSpace: true, executableComments: true },
  // SQLite: '' strings, "names", `names` and [names]; $name is a parameter.
  sqlite: { ...BASE, backtick: true, brackets: true },
  // SQL Server / Fabric: '' strings, "names" and [names].
  mssql: { ...BASE, brackets: true },
  fabric: { ...BASE, brackets: true },
  // ClickHouse: backslash escapes in strings and names, "names" and `names`, heredoc strings; `#` read either way.
  clickhouse: { ...BASE, backslash: true, doubleQuoteBackslash: true, backtick: true, backtickBackslash: true, dollar: 'either', hash: 'either' },
  // Databricks (Spark): '...' and "..." strings, backslashes unless escapedStringLiterals, no doubling, r'' raw, `names`.
  databricks: { ...BASE, backslash: 'either', doubled: false, doubleQuote: 'string', doubleQuoteBackslash: 'either', backtick: true, rawStrings: true },
  // Trino: '' strings, "names".
  trino: { ...BASE },
  // Athena: Trino for queries; backticks are Hive's (DDL), read both ways.
  athena: { ...BASE, backtick: 'either' },
};

/** Whether DQL knows how this engine reads a statement. */
export function knownLexicon(driver: string): boolean {
  return Object.prototype.hasOwnProperty.call(LEXICONS, driver);
}

/** Every concrete reading of an engine's lexicon (one per combination of the settings DQL cannot see). */
function readings(lexicon: Lexicon): Lexicon[] {
  let all: Lexicon[] = [lexicon];
  const choose = <K extends keyof Lexicon>(key: K, values: Array<Lexicon[K]>) => {
    all = all.flatMap((item) => values.map((value) => ({ ...item, [key]: value })));
  };
  for (const key of ['backslash', 'doubleQuoteBackslash', 'backtick', 'backtickBackslash', 'hash'] as const) {
    if (lexicon[key] === 'either') choose(key, [true, false]);
  }
  if (lexicon.dollar === 'either') choose('dollar', ['tagged', 'none']);
  return all;
}

const ASCII_SPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v']);
/** A character outside text that engines read differently (a space to some, part of a name or an error to others). */
const AMBIGUOUS_CHAR = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u00a0\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff\ufff9-\ufffb]/;
/** Line breaks other than a comment's own `\n` (or `\r\n`). */
const OTHER_BREAK = /\r(?!\n)|[\u000b\u000c\u0085\u2028\u2029]/;
const WORD = /[\p{L}_][\p{L}\p{N}_$]*/uy;
const NUMBER = /[0-9][0-9.eE_]*/y;
const DOLLAR_TAG = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;

/** The ASCII words some engine could read a word with other letters as (a case fold, a Unicode normalisation). */
function asciiFolds(word: string): string[] | undefined {
  if (/^[\x00-\x7f]*$/.test(word)) return undefined;
  const folds = new Set<string>();
  for (const variant of [word.normalize('NFKC'), word.toUpperCase(), word.toLowerCase(), word.normalize('NFKC').toUpperCase()]) {
    if (/^[\x00-\x7f]+$/.test(variant)) folds.add(variant.toLowerCase());
  }
  return folds.size ? [...folds] : undefined;
}

/** One concrete reading of a statement. */
function scan(sql: string, lexicon: Lexicon): SqlToken[] {
  const tokens: SqlToken[] = [];
  const length = sql.length;
  let index = 0;
  const previousAdjacentWord = (pattern: RegExp): boolean => {
    const previous = tokens[tokens.length - 1];
    return Boolean(previous && previous.kind === 'word' && previous.end === index && pattern.test(previous.text));
  };
  /** A quoted run from `index` (at its opening quote) to its closing quote; returns the index after it. */
  const quotedRun = (open: string, close: string, backslash: boolean, doubled: boolean, triple = false): { end: number; text: string } => {
    const width = triple ? 3 : 1;
    const closer = close.repeat(width);
    let at = index + width;
    let text = '';
    for (;;) {
      if (at >= length) throw new UnreadableStatement('unterminated string or name');
      const char = sql[at]!;
      if (backslash && char === '\\') {
        if (at + 1 >= length) throw new UnreadableStatement('unterminated string or name');
        text += sql.slice(at, at + 2);
        at += 2;
        continue;
      }
      if (sql.startsWith(closer, at)) {
        if (!triple && doubled && sql[at + 1] === close) { text += close; at += 2; continue; }
        return { end: at + width, text };
      }
      text += char;
      at += 1;
    }
  };
  /** A line comment from `index`: refused when another line break could end it earlier for some engine. */
  const lineComment = (from: number): number => {
    const newline = sql.indexOf('\n', from);
    const end = newline < 0 ? length : newline + 1;
    const body = sql.slice(from, newline < 0 ? length : newline);
    if (OTHER_BREAK.test(body.endsWith('\r') ? body.slice(0, -1) : body)) throw new UnreadableStatement('a line comment holds another line break');
    return end;
  };

  while (index < length) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (ASCII_SPACE.has(char)) { index += 1; continue; }
    if (AMBIGUOUS_CHAR.test(char)) throw new UnreadableStatement('a character engines read differently');

    // Comments.
    if (char === '-' && next === '-' && (!lexicon.dashNeedsSpace || index + 2 >= length || /[\s\u0000-\u001f]/.test(sql[index + 2]!))) {
      index = lineComment(index + 2);
      continue;
    }
    if (char === '#' && lexicon.hash === true) { index = lineComment(index + 1); continue; }
    if (char === '/' && next === '/' && lexicon.slash) { index = lineComment(index + 2); continue; }
    if (char === '/' && next === '*') {
      if (lexicon.executableComments && (sql[index + 2] === '!' || (sql[index + 2] === 'M' && sql[index + 3] === '!'))) throw new UnreadableStatement('executable comment');
      const end = sql.indexOf('*/', index + 2);
      if (end < 0) throw new UnreadableStatement('unterminated comment');
      // Some engines nest block comments and some do not: a comment that opens another is read two ways.
      if (sql.slice(index + 2, end).includes('/*')) throw new UnreadableStatement('nested comment');
      index = end + 2;
      continue;
    }

    // Dollar-quoted strings.
    if (char === '$' && lexicon.dollar !== 'none') {
      DOLLAR_TAG.lastIndex = index;
      const tag = DOLLAR_TAG.exec(sql);
      if (tag && (lexicon.dollar === 'tagged' || tag[0] === '$$')) {
        const end = sql.indexOf(tag[0], index + tag[0].length);
        if (end < 0) throw new UnreadableStatement('unterminated string');
        tokens.push({ kind: 'string', text: sql.slice(index + tag[0].length, end), start: index, end: end + tag[0].length });
        index = end + tag[0].length;
        continue;
      }
    }

    // Strings and quoted names.
    if (char === "'" || (char === '"' && lexicon.doubleQuote === 'string')) {
      const raw = lexicon.rawStrings && previousAdjacentWord(/^(?:r|rb|br)$/i);
      const escape = lexicon.escapeStrings && char === "'" && previousAdjacentWord(/^e$/i);
      const configured = char === "'" ? lexicon.backslash : lexicon.doubleQuoteBackslash;
      const backslash = raw ? false : escape ? true : configured === true;
      const triple = lexicon.tripleQuotes && sql.startsWith(char.repeat(3), index);
      const run = quotedRun(char, char, backslash, lexicon.doubled, triple);
      tokens.push({ kind: 'string', text: run.text, start: index, end: run.end });
      index = run.end;
      continue;
    }
    if (char === '"') {
      const run = quotedRun('"', '"', lexicon.doubleQuoteBackslash === true, true);
      tokens.push({ kind: 'quoted', text: run.text, start: index, end: run.end });
      index = run.end;
      continue;
    }
    if (char === '`' && lexicon.backtick === true) {
      const raw = lexicon.rawStrings && previousAdjacentWord(/^(?:r|rb|br)$/i);
      const run = quotedRun('`', '`', !raw && lexicon.backtickBackslash === true, !lexicon.backtickBackslash);
      tokens.push({ kind: 'quoted', text: run.text, start: index, end: run.end });
      index = run.end;
      continue;
    }
    if (char === '[' && lexicon.brackets) {
      const run = quotedRun('[', ']', false, true);
      tokens.push({ kind: 'quoted', text: run.text, start: index, end: run.end });
      index = run.end;
      continue;
    }

    WORD.lastIndex = index;
    const word = WORD.exec(sql);
    if (word) {
      const folds = asciiFolds(word[0]);
      tokens.push({ kind: 'word', text: word[0], start: index, end: index + word[0].length, ...(folds ? { folds } : {}) });
      index += word[0].length;
      continue;
    }
    NUMBER.lastIndex = index;
    const number = NUMBER.exec(sql);
    if (number) {
      tokens.push({ kind: 'number', text: number[0], start: index, end: index + number[0].length });
      index += number[0].length;
      continue;
    }
    // A sign outside ASCII that normalises to one (a full-width quote, semicolon or bracket) is read two ways.
    if (char.charCodeAt(0) >= 0x80 && /^[\x00-\x7f]+$/.test(char.normalize('NFKC'))) throw new UnreadableStatement('a sign that normalises to another');
    tokens.push({ kind: 'punct', text: char, start: index, end: index + 1 });
    index += 1;
  }
  return tokens;
}

const signature = (tokens: SqlToken[]): string => tokens.map((token) => `${token.kind[0]}${token.start}:${token.end}`).join(' ');

/**
 * The statement's tokens as `driver` reads it, the same under every setting
 * the engine could have; throws UnreadableStatement when the engine is not
 * known, the text cannot be read, or two readings disagree.
 */
export function lexStatement(sql: string, driver: string): SqlToken[] {
  const lexicon = LEXICONS[driver];
  if (!lexicon) throw new UnreadableStatement('unknown engine');
  const [first, ...others] = readings(lexicon);
  const tokens = scan(sql, first!);
  const expected = others.length ? signature(tokens) : '';
  for (const reading of others) {
    if (signature(scan(sql, reading)) !== expected) throw new UnreadableStatement('the engine could read this statement in more than one way');
  }
  return tokens;
}
