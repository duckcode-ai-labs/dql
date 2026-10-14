import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureMetadataCatalogFresh, planAgentAnswer } from './catalog.js';
import { grainMatches, requestedGrainFromPlan } from './grain-gate.js';
import { buildAnalysisQuestionPlan } from './analysis-planner.js';

/**
 * Offline `wrong-grain` eval category, mirroring the route-assertion shape used
 * by the `zlens agent eval` harness (apps/cli `runEval`). It runs each case
 * through `planAgentAnswer` and checks that the realized route matches the
 * expected route. Running it with the gate's verdict applied vs. ignored shows
 * that the grain gate is what improves grain-match precision — without needing a
 * live LLM provider.
 */

interface WrongGrainCase {
  name: string;
  question: string;
  /** Tier-1 expected only when the block grain truly satisfies the question. */
  expectedRoute: 'certified' | 'generated_sql';
}

const CASES: WrongGrainCase[] = [
  // wrong grain: player-grain block, team-grain question → must demote.
  { name: 'player block for team question', question: 'Show total points by team', expectedRoute: 'generated_sql' },
  // wrong grain: player-grain block, region-grain question → must demote.
  { name: 'player block for region question', question: 'Show total points by region', expectedRoute: 'generated_sql' },
  // true match: player-grain block, player-grain question → must stay Tier 1.
  { name: 'player block for player question', question: 'Show total points by player', expectedRoute: 'certified' },
];

describe('wrong-grain eval category', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dql-grain-eval-'));
    seedGrainProject(projectRoot);
    await ensureMetadataCatalogFresh(projectRoot, { force: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('routes each wrong-grain case to the expected tier', async () => {
    for (const testCase of CASES) {
      const plan = await planAgentAnswer(projectRoot, { question: testCase.question, limit: 30 });
      expect(plan.routeDecision.route, `${testCase.name} (${testCase.question})`).toBe(testCase.expectedRoute);
    }
  });

  it('grain-match precision improves with the gate on', async () => {
    // Precision = fraction of cases routed to Tier 1 that are TRUE grain matches.
    // We compare the gate-on realized routing against a gate-off baseline that
    // ignores the gate verdict (serves every certified-applicable candidate at
    // Tier 1), proving the gate removes the wrong-grain false positives.
    const blockObject = {
      objectKey: 'dql:block:Player Scoring Leaders',
      objectType: 'dql_block',
      name: 'Player Scoring Leaders',
      status: 'certified',
      payload: { grain: 'player_id', entities: ['Player'], declaredOutputs: ['player_name', 'total_points'] },
    };

    let gateOnTier1 = 0;
    let gateOnTier1True = 0;
    let gateOffTier1 = 0;
    let gateOffTier1True = 0;

    for (const testCase of CASES) {
      const isTrueMatch = testCase.expectedRoute === 'certified';

      // gate-on: realized routing through the planner (gate active).
      const plan = await planAgentAnswer(projectRoot, { question: testCase.question, limit: 30 });
      if (plan.routeDecision.route === 'certified') {
        gateOnTier1 += 1;
        if (isTrueMatch) gateOnTier1True += 1;
      }

      // gate-off baseline: ignore the gate verdict — the candidate would have
      // been served at Tier 1 whenever it is certified-applicable, regardless of
      // grain. (We approximate "would have served Tier 1" as: the gate verdict
      // is the only thing that demoted it.)
      const requested = requestedGrainFromPlan(buildAnalysisQuestionPlan(testCase.question));
      const gate = grainMatches(blockObject, requested);
      const wouldServeTier1WithoutGate = plan.routeDecision.route === 'certified' || !gate.allow;
      if (wouldServeTier1WithoutGate) {
        gateOffTier1 += 1;
        if (isTrueMatch) gateOffTier1True += 1;
      }
    }

    const gateOnPrecision = gateOnTier1 === 0 ? 1 : gateOnTier1True / gateOnTier1;
    const gateOffPrecision = gateOffTier1 === 0 ? 1 : gateOffTier1True / gateOffTier1;

    // With the gate on, every Tier-1 answer is a true grain match (precision 1).
    expect(gateOnPrecision).toBe(1);
    // Without the gate, wrong-grain candidates leak into Tier 1, lowering precision.
    expect(gateOffPrecision).toBeLessThan(gateOnPrecision);
  });
});

function seedGrainProject(root: string): void {
  writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'nba_ops' }), 'utf-8');
  mkdirSync(join(root, 'blocks'), { recursive: true });
  mkdirSync(join(root, 'target'), { recursive: true });
  writeFileSync(
    join(root, 'blocks', 'player_scoring_leaders.dql'),
    `block "Player Scoring Leaders" {
  domain = "nba"
  type = "custom"
  status = "certified"
  owner = "analytics@example.com"
  description = "Certified ranking of player scoring leaders by total points."
  tags = ["nba", "player", "points", "scoring"]
  grain = "player_id"
  entities = ["Player"]
  outputs = ["player_name", "total_points"]
  examples = [{ question = "Show total points by player" }]
  query = """
    SELECT player_name, SUM(points) AS total_points
    FROM fct_player_performance
    GROUP BY 1
    ORDER BY total_points DESC
  """
}`,
    'utf-8',
  );
  writeFileSync(
    join(root, 'target', 'manifest.json'),
    JSON.stringify({
      metadata: { project_name: 'nba_analysis' },
      nodes: {
        'model.nba_analysis.fct_player_performance': {
          resource_type: 'model',
          name: 'fct_player_performance',
          alias: 'fct_player_performance',
          database: 'NBA_DB',
          schema: 'ANALYTICS',
          description: 'Player performance fact with scoring at player and season grain.',
          depends_on: { nodes: [] },
          tags: ['nba', 'player'],
          original_file_path: 'models/marts/fct_player_performance.sql',
          config: { materialized: 'table' },
          columns: {
            player_name: { name: 'player_name', data_type: 'text', description: 'Player full name.' },
            team_name: { name: 'team_name', data_type: 'text', description: 'Team name.' },
            region: { name: 'region', data_type: 'text', description: 'Region label.' },
            season: { name: 'season', data_type: 'number', description: 'NBA season year.' },
            points: { name: 'points', data_type: 'number', description: 'Points scored.' },
            total_points: { name: 'total_points', data_type: 'number', description: 'Aggregated points.' },
          },
        },
      },
      sources: {},
    }),
    'utf-8',
  );
}
