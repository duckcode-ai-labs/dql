import { deflateRawSync } from 'node:zlib';

/**
 * A result as a file to download: CSV, JSON or Excel (.xlsx). Built on the
 * server from a statement DQL ran for the export itself, so a host's rules
 * for exports (RFC 0010 HH-16) apply to exactly what the file holds.
 */
export type ExportFormat = 'csv' | 'json' | 'xlsx';
export const EXPORT_FORMATS: readonly ExportFormat[] = ['csv', 'json', 'xlsx'];

export interface ExportableResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

export interface ExportFile {
  body: Buffer;
  contentType: string;
  fileName: string;
}

export function exportFormat(value: unknown): ExportFormat | null {
  return typeof value === 'string' && (EXPORT_FORMATS as readonly string[]).includes(value) ? value as ExportFormat : null;
}

/** A file name from a title: letters, digits, dashes; never a path. */
export function exportFileName(title: string | undefined, format: ExportFormat): string {
  const base = (title ?? '').replace(/[^a-z0-9-_ ]+/gi, '').trim().replace(/\s+/g, '-').toLowerCase().slice(0, 80) || 'export';
  return `${base}.${format}`;
}

function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * CSV (RFC 4180). A text cell that a spreadsheet would read as a formula
 * (`=`, `+`, `-`, `@`, tab, carriage return at the start) is prefixed with
 * `'`, so opening the file never runs anything; numbers stay numbers.
 */
export function toCsv(result: ExportableResult): string {
  const cell = (value: unknown) => {
    let out = text(value);
    if (typeof value === 'string' && /^[=+\-@\t\r]/.test(out) && !/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(out)) out = `'${out}`;
    return /[",\n\r]/.test(out) ? `"${out.replace(/"/g, '""')}"` : out;
  };
  return [result.columns.map(cell).join(','), ...result.rows.map((row) => result.columns.map((column) => cell(row[column])).join(','))].join('\r\n') + '\r\n';
}

export function toJson(result: ExportableResult): string {
  const rows = result.rows.map((row) => Object.fromEntries(result.columns.map((column) => {
    const value = row[column];
    return [column, typeof value === 'bigint' ? value.toString() : value instanceof Date ? value.toISOString() : value ?? null];
  })));
  return `${JSON.stringify(rows, null, 2)}\n`;
}

// ── Excel ──────────────────────────────────────────────────────────────

const XML_UNSAFE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
const xml = (value: string) => value.replace(XML_UNSAFE, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function columnName(index: number): string {
  let name = '';
  let n = index + 1;
  while (n > 0) {
    const rest = (n - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function sheetXml(result: ExportableResult): string {
  const cell = (value: unknown, ref: string) => {
    if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
    if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
    const out = text(value);
    if (!out) return '';
    // Inline strings: never a formula, whatever the text starts with.
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(out.slice(0, 32_767))}</t></is></c>`;
  };
  const rows = [result.columns, ...result.rows.map((row) => result.columns.map((column) => row[column]))].map((values, rowIndex) =>
    `<row r="${rowIndex + 1}">${values.map((value, columnIndex) => cell(value, `${columnName(columnIndex)}${rowIndex + 1}`)).join('')}</row>`);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A zip archive (deflate), enough for an .xlsx package. */
export function zip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export function toXlsx(result: ExportableResult, sheetName = 'Result'): Buffer {
  const sheet = xml(sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Result');
  const files: Array<[string, string]> = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheet}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', sheetXml(result)],
  ];
  return zip(files.map(([name, data]) => ({ name, data: Buffer.from(data, 'utf8') })));
}

export function exportFile(result: ExportableResult, format: ExportFormat, title?: string): ExportFile {
  const fileName = exportFileName(title, format);
  if (format === 'csv') return { body: Buffer.from(toCsv(result), 'utf8'), contentType: 'text/csv; charset=utf-8', fileName };
  if (format === 'json') return { body: Buffer.from(toJson(result), 'utf8'), contentType: 'application/json; charset=utf-8', fileName };
  return { body: toXlsx(result, title), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileName };
}
