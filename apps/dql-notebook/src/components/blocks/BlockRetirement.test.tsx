import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { themes } from '../../themes/notebook-theme';
import { BlockReplacementLink, OpenReplacementButton, blockRetirementSummary } from './BlockRetirement';

const t = themes.paper;
const retired = {
  status: 'deprecated',
  replacedBy: 'blocks/claims/claims_dataset.dql',
  deprecatedOn: '2026-09-30',
  replacement: { name: 'Claims Dataset', path: 'blocks/claims/claims_dataset.dql' },
};

describe('a retired block names its replacement', () => {
  it('summarises only deprecated blocks, preferring the resolved replacement name', () => {
    expect(blockRetirementSummary(retired)).toEqual({ replacementName: 'Claims Dataset', replacementPath: 'blocks/claims/claims_dataset.dql', deprecatedOn: '2026-09-30' });
    expect(blockRetirementSummary({ ...retired, status: 'certified' })).toBeUndefined();
    expect(blockRetirementSummary({ status: 'deprecated', replacedBy: 'Gone', replacement: null })).toEqual({ replacementName: 'Gone' });
  });

  it('the Deprecated badge reads "Replaced by <name>" with a link to the replacement', () => {
    const markup = renderToStaticMarkup(<BlockReplacementLink info={retired} t={t} onOpen={() => undefined} />);
    expect(markup).toContain('Replaced by');
    expect(markup).toMatch(/<button[^>]*title="Open Claims Dataset"[^>]*>Claims Dataset<\/button>/);
    expect(markup).toContain('retired 2026-09-30');
  });

  it('a replacement that resolves to no block is named but not linked', () => {
    const markup = renderToStaticMarkup(<BlockReplacementLink info={{ status: 'deprecated', replacedBy: 'Gone', replacement: null }} t={t} onOpen={() => undefined} />);
    expect(markup).toContain('Gone');
    expect(markup).not.toContain('<button');
  });

  it('opening a retired block offers "Open the replacement" only when it resolves', () => {
    expect(renderToStaticMarkup(<OpenReplacementButton info={retired} t={t} onOpen={() => undefined} />)).toContain('Open the replacement');
    expect(renderToStaticMarkup(<OpenReplacementButton info={{ status: 'deprecated', replacedBy: 'Gone', replacement: null }} t={t} onOpen={() => undefined} />)).toBe('');
    expect(renderToStaticMarkup(<BlockReplacementLink info={{ status: 'certified' }} t={t} />)).toBe('');
  });
});
