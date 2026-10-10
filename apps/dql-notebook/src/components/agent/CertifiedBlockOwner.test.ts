import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { themes } from '../../themes/notebook-theme';
import type * as PanelModule from './UnifiedAgentRunPanel';

let certifiedBlockSourceFromRun: typeof PanelModule.certifiedBlockSourceFromRun;
let CertifiedBlockSource: typeof PanelModule.CertifiedBlockSource;

beforeAll(async () => {
  vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
  const module = await import('./UnifiedAgentRunPanel');
  certifiedBlockSourceFromRun = module.certifiedBlockSourceFromRun;
  CertifiedBlockSource = module.CertifiedBlockSource;
});

function certifiedRun(payload: Record<string, unknown>, trustState = 'certified') {
  return {
    id: 'run-1',
    trustState,
    artifacts: [{ id: 'run-1:answer', kind: 'answer', trustState, payload: { kind: 'certified', certifiedBlockRef: 'block:claims.open_claims_by_region', ...payload } }],
  } as never;
}

function render(run: never): string {
  const source = certifiedBlockSourceFromRun(run);
  return source ? renderToStaticMarkup(createElement(CertifiedBlockSource, { source, t: themes.paper })) : '';
}

describe('a Certified answer names its block and its owner', () => {
  it('shows the block name and the owner the block records', () => {
    const markup = render(certifiedRun({ certifiedBlockOwner: 'maria@harbor.example' }));
    expect(markup).toContain('open_claims_by_region');
    expect(markup).toContain('Owner:');
    expect(markup).toContain('maria@harbor.example');
    expect(markup).not.toContain('not set');
  });

  it('says "not set" instead of leaving the owner blank', () => {
    const markup = render(certifiedRun({}));
    expect(markup).toContain('open_claims_by_region');
    expect(markup).toContain('Owner:');
    expect(markup).toContain('not set');
    expect(markup.replace(/<[^>]+>/g, '')).toContain('Owner: not set');
  });

  it('treats a whitespace-only owner as not set', () => {
    expect(certifiedBlockSourceFromRun(certifiedRun({ certifiedBlockOwner: '   ' }))).toEqual({ name: 'open_claims_by_region', owner: null });
  });

  it('names no block for an answer that is not certified', () => {
    expect(certifiedBlockSourceFromRun(certifiedRun({ certifiedBlockOwner: 'maria@harbor.example' }, 'governed'))).toBeUndefined();
  });
});
