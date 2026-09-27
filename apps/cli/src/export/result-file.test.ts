import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32, exportFile, exportFileName, exportFormat, toCsv, toJson, toXlsx } from './result-file.js';

/** The entries of a zip archive, by name (local headers only; enough for what `zip` writes). */
function unzip(archive: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let offset = 0;
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    const method = archive.readUInt16LE(offset + 8);
    const crc = archive.readUInt32LE(offset + 14);
    const size = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extra = archive.readUInt16LE(offset + 28);
    const name = archive.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extra;
    const data = method === 8 ? inflateRawSync(archive.subarray(start, start + size)) : archive.subarray(start, start + size);
    expect(crc32(data)).toBe(crc);
    out[name] = data.toString('utf8');
    offset = start + size;
  }
  expect(archive.readUInt32LE(archive.length - 22)).toBe(0x06054b50);
  return out;
}

const result = {
  columns: ['region', 'note', 'n'],
  rows: [
    { region: 'CA', note: 'says "hi", ok', n: 3 },
    { region: 'US', note: '=HYPERLINK("http://x")', n: -5 },
    { region: null, note: '-12.5', n: 1.5 },
  ],
};

describe('result files (RFC 0010 HH-17 exports)', () => {
  it('writes CSV that no spreadsheet runs as a formula', () => {
    expect(toCsv(result)).toBe('region,note,n\r\nCA,"says ""hi"", ok",3\r\nUS,"\'=HYPERLINK(""http://x"")",-5\r\n,-12.5,1.5\r\n');
  });

  it('writes JSON rows in column order, nulls kept', () => {
    expect(JSON.parse(toJson(result))).toEqual([
      { region: 'CA', note: 'says "hi", ok', n: 3 },
      { region: 'US', note: '=HYPERLINK("http://x")', n: -5 },
      { region: null, note: '-12.5', n: 1.5 },
    ]);
  });

  it('writes an Excel workbook: a valid zip, numbers as numbers, text never a formula', () => {
    const files = unzip(toXlsx(result, 'Revenue by region'));
    expect(Object.keys(files)).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml']);
    expect(files['xl/workbook.xml']).toContain('<sheet name="Revenue by region"');
    const sheet = files['xl/worksheets/sheet1.xml'];
    expect(sheet).toContain('<c r="A1" t="inlineStr"><is><t xml:space="preserve">region</t></is></c>');
    expect(sheet).toContain('<c r="C3"><v>-5</v></c>');
    expect(sheet).toContain('<t xml:space="preserve">=HYPERLINK(&quot;http://x&quot;)</t>');
    expect(sheet).not.toContain('<f>');
  });

  it('names files from a title, never a path, and reads only known formats', () => {
    expect(exportFileName('../../etc/Revenue by region!', 'xlsx')).toBe('etcrevenue-by-region.xlsx');
    expect(exportFileName(undefined, 'csv')).toBe('export.csv');
    expect(exportFormat('xlsx')).toBe('xlsx');
    expect(exportFormat('html')).toBeNull();
    expect(exportFile(result, 'json', 'Claims').contentType).toBe('application/json; charset=utf-8');
  });
});
