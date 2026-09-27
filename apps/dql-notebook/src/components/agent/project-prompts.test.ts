import { describe, expect, it } from 'vitest';
import { projectExamplePrompts } from './project-prompts';

const metric = (name: string, label = '') => ({ name, label, description: '', domain: 'claims', sql: '', type: 'sum', table: '', tags: [], owner: null }) as never;
const dimension = (name: string, label = '') => ({ name, label, description: '' }) as never;

describe('example questions from the project', () => {
  it('asks about the project\'s own metrics, by a dimension and over time', () => {
    expect(projectExamplePrompts([metric('claims_paid', 'Claims paid'), metric('claim_count', 'Claim count')], [dimension('region', 'Region'), dimension('reported_date')], [dimension('reported_date')]).map((prompt) => prompt.prompt)).toEqual([
      'What is claims paid?', 'Claims paid by region', 'How has claim count changed over time?', 'What is claim count?',
    ]);
  });

  it('is empty without metrics, so Ask shows general examples', () => {
    expect(projectExamplePrompts([], [dimension('region')], [])).toEqual([]);
  });
});
