import { describe, expect, it } from 'vitest';
import { SemanticLayer } from '@zlens/core';
import type { AgentMessage, AgentProvider } from '../providers/types.js';
import { extractFirstJsonObject, selectSemanticMembersViaLlm } from './member-select.js';

function layer(): SemanticLayer {
  return new SemanticLayer({
    metrics: [{ name: 'total_revenue', label: 'Total Revenue', description: 'Recognized revenue.', domain: 'finance', sql: 'amount', type: 'sum', table: 'orders' }],
    dimensions: [{ name: 'channel', label: 'Channel', description: 'Sales channel.', domain: 'finance', sql: 'channel', type: 'string', table: 'orders' }],
  });
}

function providerReturning(response: string): AgentProvider {
  return {
    name: 'claude',
    available: async () => true,
    generate: async (_messages: AgentMessage[]) => response,
  } as AgentProvider;
}

describe('extractFirstJsonObject', () => {
  it('extracts a fenced JSON object and ignores trailing prose', () => {
    expect(extractFirstJsonObject('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractFirstJsonObject('here you go {"a": {"b": 2}} thanks')).toEqual({ a: { b: 2 } });
  });
  it('returns undefined when there is no object', () => {
    expect(extractFirstJsonObject('no json here')).toBeUndefined();
  });
});

describe('selectSemanticMembersViaLlm', () => {
  it('parses a valid member selection restricted to real members', async () => {
    const selection = await selectSemanticMembersViaLlm({
      provider: providerReturning('{"metrics":["total_revenue"],"dimensions":["channel"],"limit":5}'),
      semanticLayer: layer(),
      question: 'revenue by channel',
    });
    expect(selection).toMatchObject({ metrics: ['total_revenue'], dimensions: ['channel'], limit: 5 });
  });

  it('returns undefined when the model selects no metric', async () => {
    const selection = await selectSemanticMembersViaLlm({
      provider: providerReturning('{"metrics":[]}'),
      semanticLayer: layer(),
      question: 'unrelated',
    });
    expect(selection).toBeUndefined();
  });

  it('returns undefined when the provider throws (offline-safe)', async () => {
    const provider = { name: 'claude', available: async () => true, generate: async () => { throw new Error('no key'); } } as AgentProvider;
    expect(await selectSemanticMembersViaLlm({ provider, semanticLayer: layer(), question: 'q' })).toBeUndefined();
  });

  it('AGT-021 preserves every explicitly named metric and measure when the model selects only one', async () => {
    const names = [
      'percent_dod_eu_core_ccu_acm_qty',
      'percent_dod_eu_core_ccu_bcm',
      'percent_dod_eu_core_ccu_bcm_qty',
      'percent_dod_legacy_acm_qty',
      'percent_dod_legacy_bcm',
    ];
    const semanticLayer = new SemanticLayer({
      metrics: names.map((name, index) => ({
        name,
        label: name,
        description: '',
        domain: 'consumption',
        sql: name,
        type: 'sum' as const,
        table: 'consumption_daily',
        objectKind: index === 2 ? 'metric' as const : 'measure' as const,
      })),
      dimensions: [{
        name: 'customer_name',
        label: 'Customer',
        description: '',
        domain: 'consumption',
        sql: 'customer_name',
        type: 'string',
        table: 'consumption_daily',
      }],
    });
    const provider = {
      name: 'claude',
      available: async () => true,
      generate: async (messages: AgentMessage[]) => {
        const prompt = messages.map((message) => message.content).join('\n');
        for (const name of names) expect(prompt).toContain(name);
        return JSON.stringify({
          metrics: [names[2]],
          filters: [{ dimension: 'customer_name', operator: 'equals', values: ['Capital One'] }],
        });
      },
    } as AgentProvider;

    const selection = await selectSemanticMembersViaLlm({
      provider,
      semanticLayer,
      question: `what is ${names.map((name) => `"${name}"`).join(', ')} for Capital One?`,
    });

    expect(selection?.metrics).toEqual(names);
    expect(selection?.filters).toEqual([{
      dimension: 'customer_name',
      operator: 'equals',
      values: ['Capital One'],
    }]);
  });

  it('rejects invented semantic member names at the resolver boundary', async () => {
    const selection = await selectSemanticMembersViaLlm({
      provider: providerReturning('{"metrics":["invented_revenue"],"dimensions":["invented_region"]}'),
      semanticLayer: layer(),
      question: 'revenue by region',
    });
    expect(selection).toBeUndefined();
  });

  it('ranks a relevant metric into the bounded prompt from a 7,000-metric catalog', async () => {
    const metrics = Array.from({ length: 7_000 }, (_, index) => ({
      name: `metric_${index}`,
      label: `Metric ${index}`,
      description: 'Unrelated operational measure.',
      domain: 'operations',
      sql: `metric_${index}`,
      type: 'sum' as const,
      table: 'facts',
    }));
    metrics[6_789] = {
      name: 'monthly_rollover_balance_amount',
      label: 'Monthly Rollover Balance Amount',
      description: 'Actual eligible balance carried into the next month.',
      domain: 'operations',
      sql: 'rollover_balance',
      type: 'sum',
      table: 'facts',
    };
    const semanticLayer = new SemanticLayer({ metrics, dimensions: [] });
    const provider = {
      name: 'claude',
      available: async () => true,
      generate: async (messages: AgentMessage[]) => {
        const prompt = messages.map((message) => message.content).join('\n');
        expect(prompt).toContain('monthly_rollover_balance_amount');
        return '{"metrics":["monthly_rollover_balance_amount"]}';
      },
    } as AgentProvider;

    const selection = await selectSemanticMembersViaLlm({
      provider,
      semanticLayer,
      question: 'what is the monthly rollover balance amount',
    });
    expect(selection?.metrics).toEqual(['monthly_rollover_balance_amount']);
  });

  it('rejects a real catalog member that was not present in the bounded prompt', async () => {
    const metrics = Array.from({ length: 80 }, (_, index) => ({
      name: `metric_${index}`,
      label: `Metric ${index}`,
      description: index === 79 ? 'Hidden catalog member.' : 'Visible operational measure.',
      domain: 'operations',
      sql: `metric_${index}`,
      type: 'sum' as const,
      table: 'facts',
    }));
    const semanticLayer = new SemanticLayer({ metrics, dimensions: [] });
    const provider = {
      name: 'claude',
      available: async () => true,
      generate: async (messages: AgentMessage[]) => {
        const prompt = messages.map((message) => message.content).join('\n');
        expect(prompt).not.toContain('- metric_79');
        return '{"metrics":["metric_79"]}';
      },
    } as AgentProvider;

    const selection = await selectSemanticMembersViaLlm({
      provider,
      semanticLayer,
      question: 'unrelated metric',
    });
    expect(selection).toBeUndefined();
  });
});

describe('selectSemanticMembersViaLlm — compatible-dimension restriction', () => {
  function capturingProvider(): { provider: AgentProvider; lastPrompt: () => string } {
    let captured = '';
    const provider = {
      name: 'claude',
      available: async () => true,
      generate: async (messages: AgentMessage[]) => {
        captured = messages.map((m) => m.content).join('\n');
        return '{"metrics":["total_bcm"],"dimensions":["customer_name"]}';
      },
    } as AgentProvider;
    return { provider, lastPrompt: () => captured };
  }

  it('shows only dimensions groupable by the candidate metric, hides unconnected ones', async () => {
    const l = new SemanticLayer({
      metrics: [{ name: 'total_bcm', label: 'Total BCM', description: 'Billed consumption.', domain: 'bcm', sql: 'SUM(bcm_amount)', type: 'sum', table: 'bcm_hdr', cube: 'bcm_hdr' }],
      dimensions: [
        // On the metric's own model → compatible.
        { name: 'customer_name', label: 'Customer', description: '', domain: 'bcm', sql: 'customer_name', type: 'string', table: 'bcm_hdr', cube: 'bcm_hdr' },
        // On a disconnected model with no join path → NOT groupable.
        { name: 'campaign_channel', label: 'Channel', description: '', domain: 'mkt', sql: 'channel', type: 'string', table: 'marketing_events', cube: 'marketing_events' },
      ],
    });
    const { provider, lastPrompt } = capturingProvider();
    await selectSemanticMembersViaLlm({ provider, semanticLayer: l, question: 'bcm by customer or channel' });
    const prompt = lastPrompt();
    expect(prompt).toContain('groupable by the metrics above');
    expect(prompt).toContain('customer_name');
    expect(prompt).not.toContain('campaign_channel');
  });

  it('requireDimensions forces the requested (connected) breakdown into the prompt', async () => {
    const l = new SemanticLayer({
      metrics: [{ name: 'total_bcm', label: 'Total BCM', description: 'Billed consumption.', domain: 'bcm', sql: 'SUM(bcm_amount)', type: 'sum', table: 'bcm_hdr', cube: 'bcm_hdr' }],
      dimensions: [
        { name: 'customer_name', label: 'Customer', description: '', domain: 'bcm', sql: 'customer_name', type: 'string', table: 'bcm_hdr', cube: 'bcm_hdr' },
      ],
    });
    const { provider, lastPrompt } = capturingProvider();
    await selectSemanticMembersViaLlm({ provider, semanticLayer: l, question: 'total bcm', requireDimensions: ['customer_name'] });
    const prompt = lastPrompt();
    expect(prompt).toContain('You MUST include these dimensions as group-bys');
    expect(prompt).toContain('customer_name');
  });

  it('requireDimensions drops an unconnected dimension rather than instructing an impossible group-by', async () => {
    const l = new SemanticLayer({
      metrics: [{ name: 'total_bcm', label: 'Total BCM', description: 'Billed consumption.', domain: 'bcm', sql: 'SUM(bcm_amount)', type: 'sum', table: 'bcm_hdr', cube: 'bcm_hdr' }],
      dimensions: [
        { name: 'customer_name', label: 'Customer', description: '', domain: 'bcm', sql: 'customer_name', type: 'string', table: 'bcm_hdr', cube: 'bcm_hdr' },
        { name: 'campaign_channel', label: 'Channel', description: '', domain: 'mkt', sql: 'channel', type: 'string', table: 'marketing_events', cube: 'marketing_events' },
      ],
    });
    const { provider, lastPrompt } = capturingProvider();
    await selectSemanticMembersViaLlm({ provider, semanticLayer: l, question: 'total bcm', requireDimensions: ['campaign_channel'] });
    const prompt = lastPrompt();
    // The unconnected dimension is filtered by the compatibility restriction, so no
    // impossible "you MUST group by campaign_channel" instruction is emitted.
    expect(prompt).not.toContain('You MUST include these dimensions as group-bys');
  });

  it('AGT-014 rejects a dimension that belongs to a different candidate metric instead of silently substituting it', async () => {
    const semanticLayer = new SemanticLayer({
      metrics: [
        { name: 'total_bcm', label: 'Total BCM', description: '', domain: 'bcm', sql: 'SUM(bcm)', type: 'sum', table: 'bcm_hdr', cube: 'bcm_hdr' },
        { name: 'ad_spend', label: 'Ad spend', description: '', domain: 'marketing', sql: 'SUM(spend)', type: 'sum', table: 'campaigns', cube: 'campaigns' },
      ],
      dimensions: [
        { name: 'customer_name', label: 'Customer', description: '', domain: 'bcm', sql: 'customer_name', type: 'string', table: 'bcm_hdr', cube: 'bcm_hdr' },
        { name: 'campaign_channel', label: 'Channel', description: '', domain: 'marketing', sql: 'channel', type: 'string', table: 'campaigns', cube: 'campaigns' },
      ],
    });
    const selection = await selectSemanticMembersViaLlm({
      provider: providerReturning('{"metrics":["total_bcm"],"dimensions":["campaigns.campaign_channel"]}'),
      semanticLayer,
      question: 'bcm by campaign channel',
    });
    expect(selection).toBeUndefined();
  });
});
