import { describe, expect, it } from 'vitest';
import type { DQLContext } from '@zlens/mcp';
import { __test__ } from './claude-agent-sdk.js';

describe('claudeAgentSdkRunner governed prompt', () => {
  it('instructs Claude Agent SDK to carry prior result refs into metadata follow-ups', () => {
    const prompt = __test__.systemPrompt({
      manifest: { blocks: {} },
      semanticLayer: {
        listMetrics: () => [],
        listDimensions: () => [],
      },
    } as unknown as DQLContext);

    expect(prompt).toContain('query_via_metadata');
    expect(prompt).toContain('followUp.priorResultRef');
    expect(prompt).toContain('followUp.priorDqlArtifact');
    expect(prompt).toContain('previous results');
  });
});
