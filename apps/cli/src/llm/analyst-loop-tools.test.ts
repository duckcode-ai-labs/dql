import type { AnswerLoopInput } from '@zlens/agent';
import { describe, expect, it } from 'vitest';
import { buildAnalystLoopTools } from './analyst-loop-tools.js';

// The tools are constructed lazily — nothing calls into the layer until the
// model invokes one — so presence is all these cases need to establish.
function loopInput(overrides: Partial<AnswerLoopInput> = {}): AnswerLoopInput {
  return {
    answerLoopTools: [
      { name: 'search_metadata', description: 'stub', parameters: { type: 'object', properties: {} } },
    ],
    ...overrides,
  } as unknown as AnswerLoopInput;
}

const withLayer = { semanticLayer: {} as never };

describe('analyst loop tool surface', () => {
  it('offers the governed semantic tools when a layer is configured', () => {
    const names = buildAnalystLoopTools(loopInput(withLayer), { valuesEnabled: false })
      .map((tool) => tool.name);
    // compile_semantic_query is the IR, and the ONLY path whose output the
    // pipeline will label governed. Losing it silently downgrades every
    // semantic answer to hand-written SQL rather than failing loudly, which is
    // exactly how it went missing the first time.
    expect(names).toContain('compile_semantic_query');
    expect(names).toContain('search_semantic_layer');
    expect(names).toContain('check_compatibility');
    expect(names).toContain('explain_metric');
  });

  it('keeps the host catalog tools alongside them', () => {
    const names = buildAnalystLoopTools(loopInput(withLayer), { valuesEnabled: false })
      .map((tool) => tool.name);
    expect(names).toContain('search_metadata');
    expect(new Set(names).size).toBe(names.length);
  });

  it('omits the semantic tools when no layer is configured', () => {
    const names = buildAnalystLoopTools(loopInput(), { valuesEnabled: false })
      .map((tool) => tool.name);
    expect(names).not.toContain('compile_semantic_query');
    expect(names).toContain('search_metadata');
  });

  it('offers preview and value lookup only when SQL can actually execute', () => {
    const withoutExecutor = buildAnalystLoopTools(loopInput(withLayer), { valuesEnabled: true })
      .map((tool) => tool.name);
    // Offering a tool that can only ever fail spends an iteration to learn nothing.
    expect(withoutExecutor).not.toContain('preview_query');
    expect(withoutExecutor).not.toContain('search_values');

    const withExecutor = buildAnalystLoopTools(
      loopInput({ ...withLayer, executeGeneratedSql: async () => ({ rows: [], columns: [] }) } as never),
      { valuesEnabled: true },
    ).map((tool) => tool.name);
    expect(withExecutor).toContain('preview_query');
    expect(withExecutor).toContain('search_values');
  });

  it('still offers search_values when probing is disabled, so it can say it did not look', () => {
    // A silent empty result would be indistinguishable from "looked and found
    // nothing" — and only one of those licenses an absence claim.
    const names = buildAnalystLoopTools(
      loopInput({ ...withLayer, executeGeneratedSql: async () => ({ rows: [], columns: [] }) } as never),
      { valuesEnabled: false },
    ).map((tool) => tool.name);
    expect(names).toContain('search_values');
  });
});
