import { afterEach, describe, expect, it } from 'vitest';
import { RESEARCH_BUDGET, researchWallClockMs } from './research-loop.js';

const original = process.env.ZLENS_AGENT_DEADLINE_SCALE;
afterEach(() => {
  if (original === undefined) delete process.env.ZLENS_AGENT_DEADLINE_SCALE;
  else process.env.ZLENS_AGENT_DEADLINE_SCALE = original;
});

describe('research budget scaling', () => {
  it('keeps the hosted default when nothing is set', () => {
    delete process.env.ZLENS_AGENT_DEADLINE_SCALE;
    expect(researchWallClockMs()).toBe(120_000);
    expect(RESEARCH_BUDGET.wallClockMs).toBe(120_000);
  });

  it('scales with the one deadline knob, so a local model can finish planning', () => {
    // Measured: a local 27B takes 122-149s WARM for a four-hypothesis plan.
    // Unscaled, the 120s research budget is spent before the first branch runs.
    process.env.ZLENS_AGENT_DEADLINE_SCALE = '8';
    expect(researchWallClockMs()).toBe(960_000);
    expect(RESEARCH_BUDGET.wallClockMs).toBe(960_000);
  });

  it('never tightens below the hosted default', () => {
    process.env.ZLENS_AGENT_DEADLINE_SCALE = '0.25';
    expect(researchWallClockMs()).toBe(120_000);
  });

  it('allows more than one planner call, so a finding can redirect the run', () => {
    expect(RESEARCH_BUDGET.plannerCalls).toBeGreaterThan(1);
  });
});
