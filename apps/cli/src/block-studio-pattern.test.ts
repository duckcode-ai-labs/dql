import { describe, expect, it } from 'vitest';
import { ensureBlockStudioPattern, hostedFileRefusal, HOSTED_FILE_REFUSED, HOSTED_SETTINGS_FILE_REFUSED, parseBlockSourceMetadata } from './local-runtime.js';

const NEW_BLOCK = `block "open_claims" {
  status = "draft"
  domain = "claims"
  type = "custom"
  description = "Open claims"

  query = """
    SELECT 1 AS n
  """
}
`;

describe('a block made in Block Studio declares a reusable pattern', () => {
  it('gets "custom" when it declares none', () => {
    expect(parseBlockSourceMetadata(NEW_BLOCK).pattern).toBe('');
    expect(parseBlockSourceMetadata(ensureBlockStudioPattern(NEW_BLOCK)).pattern).toBe('custom');
  });

  it('gets "custom" when the field is empty, and keeps the rest of the block', () => {
    const empty = NEW_BLOCK.replace('type = "custom"', 'type = "custom"\n  pattern = ""');
    const fixed = ensureBlockStudioPattern(empty);
    expect(parseBlockSourceMetadata(fixed).pattern).toBe('custom');
    expect(fixed.match(/pattern\s*=/g)).toHaveLength(1);
    expect(fixed).toContain('SELECT 1 AS n');
  });

  it('never changes a pattern the author chose, and is stable when run twice', () => {
    const ranking = NEW_BLOCK.replace('type = "custom"', 'type = "custom"\n  pattern = "ranking"');
    expect(ensureBlockStudioPattern(ranking)).toBe(ranking);
    const once = ensureBlockStudioPattern(NEW_BLOCK);
    expect(ensureBlockStudioPattern(once)).toBe(once);
  });
});

describe('a hosted request for the workspace settings file', () => {
  it('is refused with the reason: connections and settings belong to Production', () => {
    for (const requested of ['dql.config.json', './dql.config.json', 'sub/DQL.config.json', 'profiles.yml']) {
      expect(hostedFileRefusal(requested), requested).toBe(HOSTED_SETTINGS_FILE_REFUSED);
    }
    expect(HOSTED_SETTINGS_FILE_REFUSED).toContain('Production');
  });

  it('keeps the general sentence for any other refused file', () => {
    for (const requested of ['.env', 'data/claims.csv', 'package.json', '']) {
      expect(hostedFileRefusal(requested), requested).toBe(HOSTED_FILE_REFUSED);
    }
  });
});
