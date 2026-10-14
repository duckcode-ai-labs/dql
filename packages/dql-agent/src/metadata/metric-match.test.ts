import { describe, it, expect } from 'vitest';
import { SemanticLayer } from '@zlens/core';
import {
  DEFAULT_METRIC_MATCH_EMBEDDING_ALPHA,
  REAL_PROVIDER_METRIC_MATCH_ALPHA,
  VECTOR_ONLY_METRIC_SCORE_FLOOR,
  VECTOR_ONLY_METRIC_SEPARATION_MARGIN,
  matchSemanticMetric,
  parseMetricDefinition,
  semanticMetricEmbeddingOptions,
} from './metric-match.js';
import type { KGNode } from '../kg/types.js';

describe('parseMetricDefinition (R2.6: structured-first, regex fallback)', () => {
  const node: KGNode = {
    nodeId: 'metric:total_revenue',
    kind: 'metric',
    name: 'total_revenue',
    description: '',
    tags: [],
    // Deliberately WRONG/stale llmContext to prove the structured def wins.
    llmContext: 'sql: SUM(stale_col)\ntable: dev.stale_table',
    sourceTier: 'semantic_layer',
  };

  it('prefers the structured semantic-layer definition over the llmContext blob', () => {
    const layer = new SemanticLayer({
      metrics: [{ name: 'total_revenue', label: 'Total Revenue', description: '', domain: 'finance', sql: 'SUM(amount)', type: 'sum', table: 'orders' }],
      dimensions: [],
    });
    expect(parseMetricDefinition(node, layer)).toEqual({ expr: 'SUM(amount)', table: 'orders' });
  });

  it('falls back to the llmContext blob when the semantic layer lacks the metric', () => {
    const layer = new SemanticLayer({ metrics: [], dimensions: [] });
    expect(parseMetricDefinition(node, layer)).toEqual({ expr: 'SUM(stale_col)', table: 'dev.stale_table' });
    // And with no layer at all.
    expect(parseMetricDefinition(node)).toEqual({ expr: 'SUM(stale_col)', table: 'dev.stale_table' });
  });

  it('rejects a degenerate metric expression (empty parens) instead of synthesizing hollow SQL', () => {
    // `COUNT()` used to pass the bare /[()]/ gate and produce `SELECT COUNT() AS x`.
    const degenerate: KGNode = { ...node, llmContext: 'sql: COUNT()\ntable: dev.orders' };
    expect(parseMetricDefinition(degenerate)).toBeUndefined();
    // Structured path: a real aggregate is accepted, and a whitespace-only table
    // no longer survives to synthesize `FROM   `.
    const okLayer = new SemanticLayer({
      metrics: [{ name: 'total_revenue', label: '', description: '', domain: 'finance', sql: 'COUNT(*)', type: 'count', table: '  orders  ' }],
      dimensions: [],
    });
    expect(parseMetricDefinition(node, okLayer)).toEqual({ expr: 'COUNT(*)', table: 'orders' });
    const badLayer = new SemanticLayer({
      metrics: [{ name: 'total_revenue', label: '', description: '', domain: 'finance', sql: 'SUM()', type: 'sum', table: 'orders' }],
      dimensions: [],
    });
    // Degenerate structured expr falls through to the (stale-but-valid) blob.
    expect(parseMetricDefinition(node, badLayer)).toEqual({ expr: 'SUM(stale_col)', table: 'dev.stale_table' });
  });
});

function metric(name: string, description = '', tags: string[] = []): KGNode {
  return {
    nodeId: `metric:${name}`,
    kind: 'metric',
    name,
    description,
    tags,
    llmContext: `sql: SUM(amount)\ntable: dev.order_items`,
    sourceTier: 'semantic_layer',
  };
}

function vectorProvider(scores: Record<string, number>) {
  const vectorForScore = (score: number): number[] => {
    const cosine = score * 2 - 1;
    return [cosine, Math.sqrt(Math.max(0, 1 - cosine * cosine))];
  };
  return {
    id: 'fixture:real-vector-lane',
    dimensions: 2,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text, index) => {
        if (index === 0) return [1, 0];
        const key = Object.keys(scores).find((name) => text.includes(name));
        return vectorForScore(key ? scores[key]! : 0.5);
      });
    },
  };
}

describe('matchSemanticMetric (spec 17, part C)', () => {
  const jaffleMetrics: KGNode[] = [
    metric('cumulative_revenue', 'Running total of recognized revenue'),
    metric('food_revenue', 'Revenue from food line items'),
    metric('drink_revenue', 'Revenue from drink line items'),
    metric('lifetime_spend', 'Total customer spend across all orders'),
    metric('order_count', 'Number of orders placed'),
  ];

  it('finds a governed metric beyond the first 400 entries in an enterprise catalog', async () => {
    const enterpriseMetrics = Array.from({ length: 7_000 }, (_, index) => metric(`metric_${index}`));
    enterpriseMetrics[6_789] = metric('recognized_partner_revenue', 'Recognized partner revenue after refunds.');
    const match = await matchSemanticMetric('recognized partner revenue', enterpriseMetrics);
    expect(match?.metric.name).toBe('recognized_partner_revenue');
  });

  it('connects "total revenue" to a revenue-family metric (the reported miss)', async () => {
    const match = await matchSemanticMetric('what is our total revenue', jaffleMetrics);
    expect(match).not.toBeNull();
    expect(match!.metric.name).toMatch(/revenue/);
    expect(match!.family).toBe('revenue');
  });

  it('prefers the named family member for "food revenue"', async () => {
    const match = await matchSemanticMetric('show me food revenue', jaffleMetrics);
    expect(match).not.toBeNull();
    expect(match!.metric.name).toBe('food_revenue');
  });

  it('matches an underscored, non-revenue-family metric name (P5a — the reported avg_tax_rate miss)', async () => {
    // 'tax' is in no MEASURE_FAMILY, so this match rests entirely on the NAME-token
    // boost — which never fired before P5a because tokenize('avg_tax_rate') stayed one
    // glued token. A decoy on the same table must not win.
    const taxMetrics: KGNode[] = [
      metric('avg_tax_rate', 'Average tax rate on order items'),
      metric('total_shipping_cost', 'Total shipping cost per order'),
    ];
    const match = await matchSemanticMetric('what is the average tax rate', taxMetrics);
    expect(match).not.toBeNull();
    expect(match!.metric.name).toBe('avg_tax_rate');
  });

  it('matches a synonym ("sales") into the revenue family', async () => {
    const match = await matchSemanticMetric('what were total sales', jaffleMetrics);
    expect(match).not.toBeNull();
    expect(match!.family).toBe('revenue');
  });

  it('advances a strong description match to compiler validation even when the metric name differs', async () => {
    const match = await matchSemanticMetric('customer lifetime contribution', [
      metric('ltv_adjusted', 'Customer lifetime contribution after refunds'),
      metric('shipment_velocity', 'Average time to deliver an order'),
    ]);
    expect(match?.metric.name).toBe('ltv_adjusted');
    expect(match?.basis).toBe('description');
  });

  it('does not promote a weak one-word description overlap', async () => {
    const match = await matchSemanticMetric('monthly cohort performance', [
      metric('shipment_velocity', 'Monthly average delivery duration'),
    ]);
    expect(match).toBeNull();
  });

  it('returns null for a bare non-measure question (honest no-match)', async () => {
    const match = await matchSemanticMetric('what is this?', jaffleMetrics);
    expect(match).toBeNull();
  });

  it('returns null when no metric is in the question family (ad-hoc falls through)', async () => {
    const match = await matchSemanticMetric('median order value by region', [
      metric('cumulative_revenue', 'Running total of recognized revenue'),
    ]);
    // "order value" shares no revenue/spend family with cumulative_revenue and
    // has weak lexical overlap → stays below threshold so generated SQL handles it.
    expect(match).toBeNull();
  });

  it('is deterministic across runs with the offline default embedding blend', async () => {
    const a = await matchSemanticMetric('total revenue this quarter', jaffleMetrics);
    const b = await matchSemanticMetric('total revenue this quarter', jaffleMetrics);
    expect(a?.metric.name).toBe(b?.metric.name);
  });
});

describe('executability-aware selection (Slice 2)', () => {
  const metricNode = (name: string, description: string) => ({
    nodeId: `metric:${name}`,
    kind: 'metric' as const,
    name,
    description,
    status: 'certified',
  }) as never;

  it('prefers the executable sibling on a lexical tie', async () => {
    const metrics = [
      metricNode('total_acm', 'Total ACM consumption measured daily'),
      metricNode('percent_dod_acm', 'Percent day over day ACM consumption measured daily'),
    ];
    const match = await matchSemanticMetric('what is the total ACM consumption', metrics, {
      canExecute: (name) => name === 'total_acm',
    });
    expect(match?.metric.name).toBe('total_acm');
  });

  it('still surfaces a runtime-only metric on a strong direct name match', async () => {
    const metrics = [
      metricNode('total_acm', 'Total ACM consumption measured daily'),
      metricNode('percent_dod_acm', 'Percent day over day ACM consumption measured daily'),
    ];
    const match = await matchSemanticMetric('show percent dod acm', metrics, {
      canExecute: (name) => name === 'total_acm',
    });
    expect(match?.metric.name).toBe('percent_dod_acm');
  });

  it('keeps a CLEARLY better runtime-only match over a weaker executable sibling (honest beats wrong)', async () => {
    // "consumption % by customer" — the ratio metric is the intent; the
    // executable total must NOT silently answer instead.
    const metrics = [
      metricNode('total_consumption', 'Total consumption'),
      metricNode('consumption_percent_share', 'Consumption percent share of total by customer, percentage breakdown'),
    ];
    const match = await matchSemanticMetric('consumption percent share by customer', metrics, {
      canExecute: (name) => name === 'total_consumption',
    });
    expect(match?.metric.name).toBe('consumption_percent_share');
  });

  it('changes nothing when no executability signal is supplied', async () => {
    const metrics = [metricNode('total_acm', 'Total ACM consumption measured daily')];
    const match = await matchSemanticMetric('total acm consumption', metrics, {});
    expect(match?.metric.name).toBe('total_acm');
  });
});

describe('name-proximity tie-breaker (BCM sibling metrics)', () => {
  // "who are the top 10 customers for BCM" scored total_bcm and percent_mom_bcm
  // identically (same name-token hit + family) and the alphabetical fallback
  // picked the month-over-month RATIO. The base metric — fewest name tokens the
  // question never said — must win the tie.
  const bcmMetrics: KGNode[] = [
    metric('percent_mom_bcm', 'Month over month percent change in billed consumption'),
    metric('percent_dod_bcm', 'Day over day percent change in billed consumption'),
    metric('total_bcm', 'Total billed consumption'),
  ];

  it('picks the base metric for a bare measure mention', async () => {
    const match = await matchSemanticMetric('who are the top 10 customers for BCM', bcmMetrics, {
      measureTerms: ['bcm'],
    });
    expect(match?.metric.name).toBe('total_bcm');
  });

  it('still picks the ratio metric when the question asks for it', async () => {
    const match = await matchSemanticMetric('percent month over month BCM change', bcmMetrics, {
      measureTerms: ['percent mom bcm'],
    });
    expect(match?.metric.name).toBe('percent_mom_bcm');
  });
});

describe('P1.1 vector-only admission', () => {
  const question = 'quasar nebula';
  const ungroundedCatalog = (count: number): KGNode[] =>
    Array.from({ length: count }, (_, index) => metric(`metric_${String(index).padStart(3, '0')}`, 'opaque catalog signal'));

  it('finds a snapshot-shortlisted target beyond the former alphabetical 96-candidate cutoff', async () => {
    const metrics = ungroundedCatalog(120);
    metrics[119] = metric('zz_vector_target', 'opaque catalog signal');
    const match = await matchSemanticMetric(question, metrics, {
      provider: vectorProvider({ zz_vector_target: 0.96 }),
      alpha: REAL_PROVIDER_METRIC_MATCH_ALPHA,
      vectorMetricShortlist: ['metric:zz_vector_target'],
    });
    expect(match).toMatchObject({ metric: { name: 'zz_vector_target' }, basis: 'embedding' });
  });

  it('reserves admission for a snapshot vector target when ninety-six weak lexical candidates exist', async () => {
    // Every weak entry has one description-token overlap, enough to enter the
    // lexical pool but not enough to be grounded.  Before the vector quota was
    // reserved, those 96 rows filled the whole hybrid window and the target was
    // never embedded at all.
    const weakLexical = Array.from({ length: 96 }, (_, index) =>
      metric(`weak_lexical_${String(index).padStart(3, '0')}`, 'quasar catalog signal'));
    const metrics = [...weakLexical, metric('zz_vector_target', 'opaque catalog signal')];
    const match = await matchSemanticMetric(question, metrics, {
      provider: vectorProvider({ zz_vector_target: 0.96 }),
      alpha: REAL_PROVIDER_METRIC_MATCH_ALPHA,
      vectorMetricShortlist: ['metric:zz_vector_target'],
    });
    expect(match).toMatchObject({ metric: { name: 'zz_vector_target' }, basis: 'embedding' });
  });

  it('leaves a large catalog unresolved when the caller supplied no compatible vector shortlist', async () => {
    const metrics = ungroundedCatalog(120);
    metrics[119] = metric('zz_vector_target', 'opaque catalog signal');
    const match = await matchSemanticMetric(question, metrics, {
      provider: vectorProvider({ zz_vector_target: 1 }),
      alpha: REAL_PROVIDER_METRIC_MATCH_ALPHA,
      vectorMetricShortlist: ['metric:not_in_this_catalog'],
    });
    expect(match).toBeNull();
  });

  it('requires both the exported vector floor and separation margin before vector-only grounding', async () => {
    expect(VECTOR_ONLY_METRIC_SCORE_FLOOR).toBe(0.86);
    expect(VECTOR_ONLY_METRIC_SEPARATION_MARGIN).toBe(0.06);
    const metrics = [metric('vector_winner', 'opaque catalog signal'), metric('vector_runner', 'opaque catalog signal')];

    const admitted = await matchSemanticMetric(question, metrics, {
      provider: vectorProvider({ vector_winner: 0.861, vector_runner: 0.8 }),
      alpha: REAL_PROVIDER_METRIC_MATCH_ALPHA,
    });
    expect(admitted).toMatchObject({ metric: { name: 'vector_winner' }, basis: 'embedding' });

    const belowFloor = await matchSemanticMetric(question, metrics, {
      provider: vectorProvider({ vector_winner: 0.859, vector_runner: 0.7 }),
      alpha: REAL_PROVIDER_METRIC_MATCH_ALPHA,
    });
    expect(belowFloor).toBeNull();

    const nearTie = await matchSemanticMetric(question, metrics, {
      provider: vectorProvider({ vector_winner: 0.9, vector_runner: 0.845 }),
      alpha: REAL_PROVIDER_METRIC_MATCH_ALPHA,
    });
    expect(nearTie).toBeNull();
  });
});

describe('Ask and Block AI must resolve the same question to the same metric', () => {
  const metric = (name: string, description = ''): KGNode => ({
    nodeId: `metric:${name}`, kind: 'metric', name, description, tags: [],
  } as KGNode);
  const pool = [
    metric('revenue', 'Total revenue across all order items.'),
    metric('drink_revenue', 'Revenue from drink and beverage products.'),
    metric('orders', 'Count of orders placed.'),
    metric('order_total', 'Gross monetary total of an order.'),
  ];

  it('keeps a qualifier the question planner stripped', async () => {
    // The planner reduces "drink revenue" to measures:["revenue"], and Ask
    // passed only those terms. The near-tie tie-breaker then charged
    // `drink_revenue` an extra for the word "drink" that the question DID
    // contain, so the generic `revenue` won — while Block AI, which passes the
    // bare prompt, picked `drink_revenue`. Same question, different metric,
    // depending on the surface.
    const question = 'what is the drink revenue by customer';
    const block = await matchSemanticMetric(question, pool);
    const ask = await matchSemanticMetric(question, pool, { measureTerms: ['revenue'] });
    expect(block?.metric.name).toBe('drink_revenue');
    expect(ask?.metric.name).toBe('drink_revenue');
  });

  it('matches a metric name across singular and plural', async () => {
    // "how many orders" reduces to the measure term "order" while the metric is
    // named `orders`; a bare token comparison scored zero on the name, so a
    // plain count question lost to `order_total`, a sum of money.
    const question = 'how many orders did we get by location';
    const ask = await matchSemanticMetric(question, pool, { measureTerms: ['count', 'order'] });
    expect(ask?.metric.name).toBe('orders');
  });

  it('still prefers the measure the question named over an unrelated dimension noun', async () => {
    // The precision case the measure-term signal exists for: "region tax by
    // product" must stay on the tax measure and never drift to a product count.
    const taxPool = [metric('tax_amount', 'Tax collected.'), metric('product_count', 'Distinct products sold.')];
    const ask = await matchSemanticMetric('region tax by product', taxPool, { measureTerms: ['tax'] });
    expect(ask?.metric.name).toBe('tax_amount');
  });
});

describe('recall: a metric whose NAME omits the question term (the BCM production failure)', () => {
  // Reported failure: "who are the top customers for BCM" returned
  // "Top by which governed metric?" with ZERO options.
  //
  // The governed metric exists; its NAME just spells the acronym out, so every
  // DETERMINISTIC grounding signal misses:
  //   nameHit             → 0 ("bcm" is not a token of billed_consumption_monthly)
  //   sharedFamily        → none ("bcm" is unseeded, and project families are
  //                          derived from metric NAME tokens: {billed, consumption})
  //   descriptionGrounded → blocked by `qContent.size >= 2`; a one-token measure
  //                          term can never clear it, even though the description
  //                          literally reads "Billed consumption (BCM)".
  //
  // The candidate DOES reach the ranker (the description puts "bcm" in
  // metricSearchText, so ftsScore > 0), and `embeddingGrounded` exists precisely
  // to rescue this case — but it requires `realEmbeddingProvider`. Every caller
  // used the offline hashed default, so it could never fire in production.
  const bcmPool: KGNode[] = [
    metric('billed_consumption_monthly', 'Billed consumption (BCM) recognized per account each month'),
    metric('order_count', 'Number of orders placed'),
    metric('lifetime_spend', 'Total customer spend across all orders'),
  ];

  /** Stand-in for a project-configured embedder: BCM ⇄ billed consumption are near-identical. */
  const semanticProvider = {
    id: 'resilient:ollama:nomic-embed-text',
    dimensions: 3,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => (/bcm|billed[_ ]consumption/i.test(text) ? [1, 0, 0] : [0, 1, 0]));
    },
  };

  it('finds it deterministically — a lone distinctive term the description names', async () => {
    // This used to need a real embedder: `descriptionGrounded` required TWO
    // hits, which a one-token question can never have, so the acronym people
    // actually type was unreachable by any deterministic path.
    const match = await matchSemanticMetric('who are the top customers for BCM', bcmPool, {
      measureTerms: ['bcm'],
    });
    expect(match?.metric.name).toBe('billed_consumption_monthly');
    expect(match?.basis).toBe('description');
  });

  it('still works with a real embedder, and sends nothing when there is none', async () => {
    // The egress property is unchanged and separate from recall: a hashed or
    // absent provider contributes no options, so no metric definition leaves the
    // host. What changed is that recall no longer DEPENDS on that call.
    expect(semanticMetricEmbeddingOptions({ id: 'hashed-token-v1', dimensions: 3, async embed(t: string[]) { return t.map(() => [0, 0, 0]); } })).toEqual({});
    expect(semanticMetricEmbeddingOptions(undefined)).toEqual({});
    const match = await matchSemanticMetric('who are the top customers for BCM', bcmPool, {
      measureTerms: ['bcm'],
      ...semanticMetricEmbeddingOptions(semanticProvider),
    });
    expect(match?.metric.name).toBe('billed_consumption_monthly');
  });

  it('does not ground on a generic prose word, which is what the count rule guarded', async () => {
    // `order_count` is described "Number of orders placed". The word "number"
    // appears only in that prose, never in the name, and proves nothing about
    // what the metric measures. Relaxing the COUNT rule must not relax the
    // genericness rule that was its real purpose.
    const match = await matchSemanticMetric('show me the number', bcmPool, { measureTerms: ['number'] });
    expect(match).toBeNull();
  });

  it('weights a real embedder well above the hashed tie-breaker default', () => {
    expect(semanticMetricEmbeddingOptions(semanticProvider).alpha).toBe(REAL_PROVIDER_METRIC_MATCH_ALPHA);
    expect(REAL_PROVIDER_METRIC_MATCH_ALPHA).toBeGreaterThan(DEFAULT_METRIC_MATCH_EMBEDDING_ALPHA);
  });
});
