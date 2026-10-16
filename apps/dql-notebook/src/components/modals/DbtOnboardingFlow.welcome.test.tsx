import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { themes } from '../../themes/notebook-theme';
import { DbtOnboardingFlow } from './DbtOnboardingFlow';

const noop = () => undefined;

describe('Welcome screen', () => {
  it('offers the same "Where does your data model live?" choice as Guided Setup', () => {
    const html = renderToStaticMarkup(
      <DbtOnboardingFlow t={themes.paper} onBack={noop} onClose={noop} onComplete={noop} onOpen={noop} onChooseModelSource={noop} />,
    );
    expect(html).toContain('Where does your data model live?');
    for (const value of ['dbt', 'warehouse', 'both', 'existing']) expect(html).toContain(`value="${value}"`);
    // dbt stays the default here, and its next step is unchanged.
    expect(html).toMatch(/<input[^>]*value="dbt"[^>]*checked=""|<input[^>]*checked=""[^>]*value="dbt"/);
    expect(html).toContain('Next — connect your dbt project');
    expect(html).toContain('straight on your database');
  });

  it('keeps the dbt-only welcome when nothing handles another choice', () => {
    const html = renderToStaticMarkup(
      <DbtOnboardingFlow t={themes.paper} onBack={noop} onClose={noop} onComplete={noop} onOpen={noop} />,
    );
    expect(html).not.toContain('Where does your data model live?');
    expect(html).toContain('Next — connect your dbt project');
  });
});
