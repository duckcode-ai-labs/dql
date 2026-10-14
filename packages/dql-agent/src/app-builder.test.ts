import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAppDocument,
  parseDashboardDocument,
} from "@zlens/core";
import { KGStore } from "./kg/sqlite-fts.js";
import {
  generateAppFromPlan,
  humanTileTitle,
  planAppFromPrompt,
  validateAppPlan,
  type AppPlan,
} from "./app-builder.js";
import type { KGNode } from "./kg/types.js";

function withKg<T>(nodes: KGNode[], fn: (kg: KGStore, dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "dql-app-plan-"));
  const kg = new KGStore(join(dir, "kg.sqlite"));
  try {
    kg.rebuild(nodes, []);
    return fn(kg, dir);
  } finally {
    kg.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const revenueNodes: KGNode[] = [
  {
    nodeId: "block:revenue_total",
    kind: "block",
    name: "revenue_total",
    domain: "growth",
    status: "certified",
    description: "Weekly revenue KPI for executive review",
    llmContext: "Use this for weekly revenue health and COO scorecards.",
    tags: ["revenue", "weekly", "kpi"],
    sourceTier: "certified_artifact",
    certification: "certified",
    decisionUse: "Weekly operating review",
    caveats: ["Current week may restate."],
  },
  {
    nodeId: "block:revenue_by_segment",
    kind: "block",
    name: "revenue_by_segment",
    domain: "growth",
    status: "certified",
    description: "Revenue split by customer segment",
    llmContext:
      "Use this for Enterprise, SMB, and Mid-Market revenue drilldowns.",
    tags: ["revenue", "segment", "drilldown"],
    sourceTier: "certified_artifact",
    certification: "certified",
  },
  {
    nodeId: "block:experimental_revenue_forecast",
    kind: "block",
    name: "experimental_revenue_forecast",
    domain: "growth",
    status: "draft",
    description: "Draft revenue forecast",
    tags: ["revenue", "forecast"],
  },
  {
    nodeId: "business_view:Revenue Health",
    kind: "business_view",
    name: "Revenue Health",
    domain: "growth",
    status: "certified",
    description: "Business view for revenue leadership.",
    llmContext: "Certified context for revenue health apps.",
    sourceTier: "business_context",
    certification: "certified",
  },
];

const nbaNodes: KGNode[] = [
  {
    nodeId: "block:top_10_goal_scorers",
    kind: "block",
    name: "top_10_goal_scorers",
    domain: "nba",
    status: "certified",
    description: "Top 10 goal scorers by player and total goal count",
    llmContext: "Use this for ranking NBA players by scoring output.",
    tags: ["nba", "player", "top", "scoring"],
    sourceTier: "certified_artifact",
    certification: "certified",
    grain: "player_name",
    entities: ["Player"],
    declaredOutputs: ["player_name", "total_points"],
    allowedFilters: ["season_start", "season_end", "top_n"],
    parameterPolicy: [
      { name: "season_start", policy: "dynamic" },
      { name: "season_end", policy: "dynamic" },
      { name: "top_n", policy: "dynamic" },
    ],
    sourceSystems: ["int_player_stats"],
    businessFingerprint: {
      version: "1",
      hash: "nba-top-scorers",
      tokens: ["source:int_player_stats", "entity:player", "metric:points", "intent:ranking"],
    },
  },
  {
    nodeId: "block:player_stats_data_availability",
    kind: "block",
    name: "player_stats_data_availability",
    domain: "nba",
    status: "certified",
    description: "Dataset availability and record counts for player stats",
    llmContext: "Use this as supporting data availability evidence.",
    tags: ["nba", "availability", "records"],
    sourceTier: "certified_artifact",
    certification: "certified",
  },
];

const jaffleNode: KGNode = {
  nodeId: "block:revenue",
  kind: "block",
  name: "revenue",
  domain: "marts",
  status: "certified",
  description: "Total product revenue",
  llmContext: "Wraps the governed semantic metric revenue.",
  tags: ["revenue", "metric"],
  sourceTier: "certified_artifact",
  certification: "certified",
  declaredOutputs: ["ordered_at", "revenue"],
  dimensions: ["ordered_at"],
  allowedFilters: ["ordered_at", "region"],
};

describe("planAppFromPrompt — convergence (filters bound to real blocks)", () => {
  it("derives the global filter bar from the block's allowedFilters, not prompt words", () =>
    withKg([jaffleNode], (kg) => {
      // The prompt never says "region", but the certified block declares it.
      const plan = planAppFromPrompt({ prompt: "revenue app", kg, domain: "marts" });
      const ids = plan.globalFilters.map((f) => f.id);
      expect(ids).toContain("ordered_at");
      expect(ids).toContain("region"); // surfaced from the block, not the prompt
      const ordered = plan.globalFilters.find((f) => f.id === "ordered_at");
      const region = plan.globalFilters.find((f) => f.id === "region");
      expect(ordered?.type).toBe("daterange"); // time → date range
      expect(region?.type).toBe("select");     // categorical → dropdown
      expect(region?.bindsTo).toBe("region");
    }));

  it("uses a search control for high-cardinality name filters", () =>
    withKg([{ ...jaffleNode, allowedFilters: ["customer_name"] }], (kg) => {
      const plan = planAppFromPrompt({ prompt: "customer revenue app", kg, domain: "marts" });
      expect(plan.globalFilters).toContainEqual(expect.objectContaining({
        id: "customer_name",
        type: "search",
        bindsTo: "customer_name",
      }));
    }));

  it("drops a prompt-inferred filter no certified tile supports (no orphans)", () =>
    withKg([jaffleNode], (kg) => {
      // "season"/years would inject season filters under the old prompt-only logic.
      const plan = planAppFromPrompt({ prompt: "revenue by season 2016 2017", kg, domain: "marts" });
      const ids = plan.globalFilters.map((f) => f.id);
      expect(ids).not.toContain("season");
      expect(ids).not.toContain("season_start");
      expect(ids).toContain("ordered_at"); // the real, supported filter remains
    }));

  it("grounds the narrative in the certified block + filter bar and reports coverage", () =>
    withKg([jaffleNode], (kg) => {
      const plan = planAppFromPrompt({ prompt: "revenue app", kg, domain: "marts" });
      expect(plan.stakeholderSummary).toContain("revenue");      // names the block
      expect(plan.stakeholderSummary.toLowerCase()).toContain("filter");
      expect(plan.coverage.certifiedTiles).toBeGreaterThan(0);
      expect(plan.coverage.ratio).toBeGreaterThan(0);
    }));
});

describe("planAppFromPrompt", () => {
  it("searches the governed catalog when App Studio starts from the general domain", () =>
    withKg(revenueNodes, (kg) => {
      const plan = planAppFromPrompt({
        prompt: "Build a weekly revenue health app for the COO",
        kg,
        domain: "general",
        allowSemanticQueries: false,
      });

      expect(plan.pages[0].tiles).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "certified_block",
          blockId: "revenue_total",
          certification: "certified",
        }),
      ]));
      expect(plan.coverage.certifiedTiles).toBeGreaterThan(0);
    }));

  it("does not let broad inferred blocks close filtered customer, product, or trend requirements", () =>
    withKg([
      {
        nodeId: "block:top_products",
        kind: "block",
        name: "top_products",
        domain: "commerce",
        status: "certified",
        description: "Top products by total revenue",
        sourceTier: "certified_artifact",
      },
      {
        nodeId: "block:top_customers",
        kind: "block",
        name: "top_customers",
        domain: "commerce",
        status: "certified",
        description: "Top customers by lifetime spend",
        sourceTier: "certified_artifact",
      },
    ], (kg) => {
      const plan = planAppFromPrompt({
        prompt: "top customers by beverage revenue, revenue by product, and revenue trend",
        kg,
        domain: "commerce",
        allowSemanticQueries: false,
      });

      const analyticalCoverage = plan.requirementCoverage.filter((coverage) => coverage.requirementId !== "headline");
      expect(analyticalCoverage.length).toBeGreaterThan(0);
      expect(analyticalCoverage.every((coverage) => coverage.status === "gap")).toBe(true);
      expect(plan.pages[0].tiles.every((tile) => tile.kind === "certified_block")).toBe(true);
      expect(plan.requirementCoverage.flatMap((coverage) => coverage.reasons).join(" ")).toMatch(/does not prove (dimensions|filters)/);
    }));

  it("plans requirement-first, uses semantic coverage only when a certified block is incompatible", () =>
    withKg([
      {
        nodeId: "block:revenue_total",
        kind: "block",
        name: "revenue_total",
        domain: "commerce",
        status: "certified",
        description: "Overall revenue with no category breakdown",
        sourceTier: "certified_artifact",
        declaredOutputs: ["revenue"],
      },
      {
        nodeId: "metric:revenue",
        kind: "metric",
        name: "revenue",
        domain: "commerce",
        status: "review",
        description: "Governed order revenue",
        sourceTier: "semantic_layer",
        provenance: "MetricFlow semantic manifest",
      },
      {
        nodeId: "semantic_model:orders",
        kind: "semantic_model",
        name: "orders",
        domain: "commerce",
        status: "review",
        description: "Orders semantic model with product category and customer",
        sourceTier: "semantic_layer",
      },
    ], (kg) => {
      const plan = planAppFromPrompt({
        prompt: "top customers by revenue for beverage product category",
        kg,
        domain: "commerce",
        snapshotId: "snapshot-1",
        preferredBlockIds: ["revenue_total"],
      });
      expect(plan.version).toBe(2);
      expect(plan.requirements.length).toBeGreaterThan(0);
      expect(plan.requirementCoverage).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "semantic_query", status: "covered", trustState: "review_required" }),
      ]));
      const semantic = plan.pages[0].tiles.find((tile) => tile.kind === "semantic_query");
      expect(semantic?.semantic).toMatchObject({
        metrics: ["revenue"],
        semanticModelRefs: ["orders"],
        filters: [{ field: "product_category", operator: "=", value: "beverage" }],
        qualifiedMetricIds: ["metric:revenue"],
        qualifiedModelIds: ["semantic_model:orders"],
        resolvedPlanFingerprint: expect.stringMatching(/^sha256:/),
        snapshotId: "snapshot-1",
      });
      expect(semantic?.filterBindings).toEqual([
        expect.objectContaining({ filter: "product-category", binding: "product_category", mode: "semantic", capability: "supported" }),
      ]);
      expect(plan.storyEvidencePlan.eligibleTileIds).toContain(semantic?.id);
    }));

  it("does not silently add semantic fallbacks when the prompt names certified blocks", () =>
    withKg([
      {
        nodeId: "block:revenue_total",
        kind: "block",
        name: "revenue_total",
        domain: "commerce",
        status: "certified",
        description: "Overall revenue KPI",
        sourceTier: "certified_artifact",
        declaredOutputs: ["revenue"],
      },
      {
        nodeId: "metric:revenue",
        kind: "metric",
        name: "revenue",
        domain: "commerce",
        status: "review",
        description: "Governed order revenue",
        sourceTier: "semantic_layer",
      },
      {
        nodeId: "semantic_model:orders",
        kind: "semantic_model",
        name: "orders",
        domain: "commerce",
        status: "review",
        description: "Orders semantic model with customer detail",
        sourceTier: "semantic_layer",
      },
    ], (kg) => {
      const plan = planAppFromPrompt({
        prompt: "Build an app using the certified revenue_total block with customer detail",
        kg,
        domain: "commerce",
      });

      expect(plan.pages[0].tiles.some((tile) => tile.kind === "semantic_query")).toBe(false);
      expect(plan.pages[0].tiles).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "certified_block", blockId: "revenue_total" }),
      ]));
      expect(plan.requirementCoverage.some((coverage) => coverage.status === "gap")).toBe(true);
    }));

  it("builds a reviewable local app plan from certified DQL context", () =>
    withKg(revenueNodes, (kg) => {
      const plan = planAppFromPrompt({
        prompt: "Build a weekly revenue health app for the COO",
        kg,
        owner: "ops@example.com",
      });

      expect(plan.skills.map((skill) => skill.id)).toEqual([
        "interpret_business_intent",
        "match_certified_context",
        "shape_business_story",
        "design_dashboard_layout",
        "draft_missing_sections",
        "route_review",
      ]);
      expect(plan.planning).toMatchObject({
        plannerMode: "deterministic",
        analysisIntent: "metric_monitoring",
        audience: "COO",
        domain: "growth",
      });
      expect(plan.planning.displayStrategy).toContain("KPIs");
      expect(plan.planning.layoutRationale).toContain("proof-backed tiles");
      expect(plan.planning.layoutRationale).toContain("scoped analysis");
      expect(plan.planning.layoutRationale).not.toMatch(/evidence tiles|review backlog/i);
      expect(plan.planning.handoffPlan.join(" ")).toContain("scoped analysis");
      expect(plan.planning.handoffPlan.join(" ")).not.toMatch(/review backlog/i);
      expect(plan.planning.certifiedContext).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            nodeId: "block:revenue_total",
            kind: "block",
          }),
          expect.objectContaining({
            nodeId: "business_view:Revenue Health",
            kind: "business_view",
          }),
        ]),
      );
      expect(plan.appId).toBe("weekly-revenue-health");
      expect(plan.domain).toBe("growth");
      expect(plan.audience).toBe("COO");
      expect(plan.stakeholderSummary).toContain("decision room");
      expect(plan.lifecycle).toBe("draft");
      expect(plan.globalFilters.map((filter) => filter.id)).toContain("week");
      expect(plan.selectedEvidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: "block:revenue_total", trustState: "certified" }),
        ]),
      );
      expect(plan.missingEvidence).toEqual(expect.any(Array));
      expect(plan.scopedReports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            title: expect.stringContaining("Growth decision story"),
            source: "app_builder",
            reviewStatus: "draft_ready",
            evidenceNeeded: expect.arrayContaining(["certified block results"]),
          }),
        ]),
      );
      expect(plan.planning.scopedReports).toEqual(plan.scopedReports);
      expect(plan.reviewTasks.join(" ")).toContain("Run scoped analysis");
      expect(plan.appSections.map((section) => section.id)).toEqual(["dashboard", "research"]);
      expect(plan.pages[0].filters.map((filter) => filter.id)).toContain(
        "week",
      );
      expect(plan.pages[0].tiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "certified_block",
            blockId: "revenue_total",
            certification: "certified",
            reviewStatus: "certified",
            trustState: "certified",
            sourceEvidence: expect.arrayContaining([
              expect.objectContaining({ source: "block:revenue_total", trustState: "certified" }),
            ]),
            display: expect.objectContaining({
              trustState: "certified",
              followUpActions: expect.arrayContaining(["open_research"]),
              genUi: expect.objectContaining({
                version: 1,
                trustState: "certified",
                allowedVisualizations: expect.arrayContaining(["line", "bar", "table"]),
              }),
            }),
          }),
        ]),
      );
      expect(plan.pages[0].tiles.every((tile) => tile.kind === "certified_block")).toBe(true);
      const validation = validateAppPlan(plan, kg);
      expect(validation.certifiedTiles).toBeGreaterThan(0);
      expect(validation.draftTiles).toBe(0);
    }));

  it("uses explicitly selected certified blocks as the exact App Studio allow-list", () =>
    withKg(revenueNodes, (kg) => {
      const plan = planAppFromPrompt({
        prompt: "Build a weekly operating app for the COO",
        kg,
        domain: "growth",
        preferredBlockIds: ["revenue_by_segment"],
      });

      const certifiedTiles = plan.pages[0].tiles.filter(
        (tile) => tile.kind === "certified_block",
      );
      expect(certifiedTiles.map((tile) => tile.blockId)).toEqual(["revenue_by_segment"]);
      expect(certifiedTiles[0]).toMatchObject({ certification: "certified" });
    }));

  it("uses an explicit stakeholder audience when supplied", () =>
    withKg(revenueNodes, (kg) => {
      const plan = planAppFromPrompt({
        prompt: "Build a weekly revenue health app",
        kg,
        domain: "growth",
        audience: "Board",
      });

      expect(plan.audience).toBe("Board");
      expect(plan.planning.audience).toBe("Board");
      expect(plan.stakeholderSummary).toContain("Board");
      expect(plan.tags).toContain("audience:board");
    }));

  it("creates season and top-N filters with certified block parameter bindings", () =>
    withKg([
      {
        nodeId: "block:nba_top_scorers_parameterized",
        kind: "block",
        name: "nba_top_scorers_parameterized",
        domain: "nba",
        status: "certified",
        description: "Top NBA scorers by total points with reusable season and limit parameters",
        llmContext: "Use this for top NBA scorers between season_start and season_end with top_n.",
        tags: ["nba", "player", "scoring", "top"],
        sourceTier: "certified_artifact",
        certification: "certified",
        allowedFilters: ["season_start", "season_end", "top_n"],
        parameterPolicy: [
          { name: "season_start", policy: "dynamic" },
          { name: "season_end", policy: "dynamic" },
          { name: "top_n", policy: "dynamic" },
        ],
        parameters: [
          { name: "season_start", type: "number", required: false, default: 2016, policy: "dynamic", binding: { kind: "semantic_filter", field: "game_date_est.year", operator: "gte" } },
          { name: "season_end", type: "number", required: false, default: 2017, policy: "dynamic", binding: { kind: "semantic_filter", field: "game_date_est.year", operator: "lte" } },
          { name: "top_n", type: "number", required: false, default: 5, policy: "dynamic", binding: { kind: "limit" } },
        ],
      },
    ], (kg) => {
      const plan = planAppFromPrompt({
        prompt: "Build an NBA stakeholder app with top_n 5 scorers for 2016 and 2017 seasons",
        kg,
        domain: "nba",
      });
      const tile = plan.pages[0].tiles.find((entry) => entry.blockId === "nba_top_scorers_parameterized");

      expect(plan.globalFilters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "season_start", default: 2016, bindsTo: "game_date_est.year" }),
          expect.objectContaining({ id: "season_end", default: 2017, bindsTo: "game_date_est.year" }),
          expect.objectContaining({ id: "top_n", default: 5, type: "number" }),
        ]),
      );
      expect(tile?.filterBindings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ filter: "season_start", mode: "parameter", paramNames: ["season_start"] }),
          expect.objectContaining({ filter: "season_end", mode: "parameter", paramNames: ["season_end"] }),
          expect.objectContaining({ filter: "top_n", mode: "parameter", paramNames: ["top_n"] }),
        ]),
      );
      expect(tile?.parameterBindings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ param: "season_start", source: "dashboard_filter", filter: "season_start" }),
          expect.objectContaining({ param: "season_end", source: "dashboard_filter", filter: "season_end" }),
          expect.objectContaining({ param: "top_n", source: "dashboard_filter", filter: "top_n", parameterType: "number", default: 5 }),
        ]),
      );
    }));

  it("honors explicit dynamic parameter names even when the prompt has no fixed values", () =>
    withKg([
      {
        nodeId: "block:nba_top_scorers_parameterized",
        kind: "block",
        name: "nba_top_scorers_parameterized",
        domain: "nba",
        status: "certified",
        description: "Top NBA scorers by total points with reusable season and limit parameters",
        llmContext: "Use this for top NBA scorers between season_start and season_end with top_n.",
        tags: ["nba", "player", "scoring", "top"],
        sourceTier: "certified_artifact",
        certification: "certified",
        allowedFilters: ["season_start", "season_end", "top_n"],
        parameterPolicy: [
          { name: "season_start", policy: "dynamic" },
          { name: "season_end", policy: "dynamic" },
          { name: "top_n", policy: "dynamic" },
        ],
      },
    ], (kg) => {
      const plan = planAppFromPrompt({
        prompt: "Build an NBA stakeholder app with season_start, season_end, and top_n filters for scorer analysis",
        kg,
        domain: "nba",
      });
      const tile = plan.pages[0].tiles.find((entry) => entry.blockId === "nba_top_scorers_parameterized");

      expect(plan.globalFilters.map((filter) => filter.id)).toEqual(
        expect.arrayContaining(["season_start", "season_end", "top_n"]),
      );
      expect(plan.globalFilters.find((filter) => filter.id === "top_n")?.default).toBeUndefined();
      expect(tile?.parameterBindings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ param: "season_start", source: "dashboard_filter", filter: "season_start" }),
          expect.objectContaining({ param: "season_end", source: "dashboard_filter", filter: "season_end" }),
          expect.objectContaining({ param: "top_n", source: "dashboard_filter", filter: "top_n" }),
        ]),
      );
    }));

  it("uses ranking and evidence GenUI panels for an NBA scorer app", () =>
    withKg(nbaNodes, (kg) => {
      const plan = planAppFromPrompt({
        prompt:
          "Build an NBA E2E QA app for Kevin Durant profile and player performance. Use certified player performance and top scorers blocks when available.",
        kg,
        domain: "nba",
        preferredBlockIds: [
          "top_10_goal_scorers",
          "player_stats_data_availability",
        ],
      });

      const scorerTile = plan.pages[0].tiles.find(
        (tile) => tile.blockId === "top_10_goal_scorers",
      );
      const availabilityTile = plan.pages[0].tiles.find(
        (tile) => tile.blockId === "player_stats_data_availability",
      );

      expect(scorerTile).toMatchObject({
        viz: "bar",
        display: expect.objectContaining({
          genUi: expect.objectContaining({
            component: "RankingPanel",
            layoutIntent: "wide",
            allowedVisualizations: expect.arrayContaining(["bar", "table", "donut"]),
          }),
        }),
      });
      expect(availabilityTile).toMatchObject({
        viz: "table",
        display: expect.objectContaining({
          genUi: expect.objectContaining({
            component: "EvidenceTable",
            layoutIntent: "standard",
          }),
        }),
      });
    }));

  it("dedupes certified blocks that answer the same app question", () =>
    withKg([
      ...nbaNodes,
      {
        nodeId: "block:codex_e2e_top_scorers",
        kind: "block",
        name: "Codex E2E NBA Top Scorers",
        domain: "nba",
        status: "certified",
        description:
          "Imported raw SQL ranking top NBA scorers from TRANSFORMED.int_player_stats. Review required before stakeholder use.",
        llmContext:
          "Use only after review for top NBA scorers from TRANSFORMED.int_player_stats.",
        tags: ["imported", "raw-sql", "nba", "top", "scorers"],
        sourceTier: "certified_artifact",
        certification: "certified",
        sourceSystems: ["TRANSFORMED.int_player_stats"],
      },
    ], (kg) => {
      const plan = planAppFromPrompt({
        prompt: "Build an NBA player performance app showing top scorers and data availability",
        kg,
        domain: "nba",
      });

      const certifiedBlockIds = plan.pages[0].tiles
        .filter((tile) => tile.kind === "certified_block")
        .map((tile) => tile.blockId);

      expect(certifiedBlockIds).toContain("top_10_goal_scorers");
      expect(certifiedBlockIds).toContain("player_stats_data_availability");
      expect(certifiedBlockIds).not.toContain("codex_e2e_top_scorers");
      expect(certifiedBlockIds.filter((id) => /scorer/i.test(id))).toHaveLength(1);
    }));

  it("retains every explicitly selected block in App Studio even when fingerprints overlap", () =>
    withKg([
      ...nbaNodes,
      {
        ...nbaNodes[0],
        nodeId: "block:executive_top_scorers",
        name: "executive_top_scorers",
        description: "Executive presentation of the same governed scorer results",
      },
    ], (kg) => {
      const plan = planAppFromPrompt({
        prompt: "Build an NBA scorer App from the sources I selected",
        kg,
        domain: "nba",
        preferredBlockIds: ["top_10_goal_scorers", "executive_top_scorers"],
      });

      const certifiedBlockIds = plan.pages[0].tiles
        .filter((tile) => tile.kind === "certified_block")
        .map((tile) => tile.blockId);
      expect(certifiedBlockIds).toEqual(expect.arrayContaining(["top_10_goal_scorers", "executive_top_scorers"]));
    }));
});

describe("validateAppPlan", () => {
  it("rejects certified tiles backed by non-certified blocks", () =>
    withKg(revenueNodes, (kg) => {
      const plan = planAppFromPrompt({
        prompt: "Build a weekly revenue health app for the COO",
        kg,
      });
      const badPlan: AppPlan = {
        ...plan,
        pages: [
          {
            ...plan.pages[0],
            tiles: [
              {
                ...plan.pages[0].tiles.find(
                  (tile) => tile.kind === "certified_block",
                )!,
                blockId: "experimental_revenue_forecast",
                certification: "certified",
                reviewStatus: "certified",
              },
            ],
          },
        ],
      };

      const validation = validateAppPlan(badPlan, kg);
      expect(validation.ok).toBe(false);
      expect(
        validation.issues.some((issue) =>
          issue.message.includes("not certified"),
        ),
      ).toBe(true);
    }));

  it("rejects generated story, trust, or research placeholders as stakeholder dashboard tiles", () =>
    withKg(revenueNodes, (kg) => {
      const plan = planAppFromPrompt({
        prompt: "Build a weekly revenue health app for the COO with driver research",
        kg,
      });
      const badPlan: AppPlan = {
        ...plan,
        pages: [
          {
            ...plan.pages[0],
            tiles: [
              ...plan.pages[0].tiles,
              {
                id: "research-drilldowns",
                title: "Research drilldowns to review",
                kind: "draft_placeholder",
                description: "Generated driver ideas that should stay out of the stakeholder dashboard.",
                viz: "text",
                certification: "uncertified",
                reviewStatus: "draft_ready",
                reviewTasks: ["Open a scoped analysis memo before stakeholder use."],
              },
            ],
          },
        ],
      };

      const validation = validateAppPlan(badPlan, kg);
      expect(validation.ok).toBe(false);
      expect(validation.draftTiles).toBe(1);
      expect(
        validation.issues.some((issue) =>
          issue.message.includes("stakeholder dashboard tiles must be certified blocks"),
        ),
      ).toBe(true);
    }));
});

describe("generateAppFromPlan", () => {
  it("builds a private draft directly from governed semantic context without a certified block", () =>
    withKg([
      {
        nodeId: "metric:revenue",
        kind: "metric",
        name: "revenue",
        domain: "commerce",
        status: "review",
        description: "Governed order revenue",
        sourceTier: "semantic_layer",
        provenance: "MetricFlow semantic manifest",
      },
      {
        nodeId: "semantic_model:orders",
        kind: "semantic_model",
        name: "orders",
        domain: "commerce",
        status: "review",
        description: "Orders semantic model with customer dimensions",
        sourceTier: "semantic_layer",
      },
    ], (kg, dir) => {
      const projectRoot = join(dir, "project");
      const plan = planAppFromPrompt({
        prompt: "Build revenue by customer",
        kg,
        domain: "commerce",
        snapshotId: "snapshot-semantic",
      });
      const validation = validateAppPlan(plan, kg);

      expect(validation.ok).toBe(true);
      expect(validation.certifiedTiles).toBe(0);
      expect(plan.pages[0].tiles.some((tile) => tile.kind === "semantic_query")).toBe(true);

      const generated = generateAppFromPlan(projectRoot, plan, kg);
      const app = JSON.parse(readFileSync(join(projectRoot, generated.paths[0]), "utf-8"));
      const dashboard = JSON.parse(readFileSync(join(projectRoot, generated.paths[1]), "utf-8"));
      expect(app).toMatchObject({ visibility: "private", publicationIntent: "shared_project" });
      expect(dashboard.layout.items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          sourceClass: "governed_semantic",
          semantic: expect.objectContaining({ qualifiedMetricIds: ["metric:revenue"] }),
          review: expect.objectContaining({ status: "required" }),
        }),
      ]));
    }));

  it("writes deterministic app and dashboard files that parse cleanly", () =>
    withKg(revenueNodes, (kg, dir) => {
      const projectRoot = join(dir, "project");
      const plan = planAppFromPrompt({
        prompt: "Build a weekly revenue health app for the COO",
        kg,
        owner: "ops@example.com",
      });

      const generated = generateAppFromPlan(projectRoot, plan, kg);

      expect(generated.paths).toEqual([
        `apps/${plan.appId}/dql.app.json`,
        `apps/${plan.appId}/dashboards/overview.dqld`,
        `apps/${plan.appId}/README.md`,
      ]);

      const appText = readFileSync(
        join(projectRoot, generated.paths[0]),
        "utf-8",
      );
      const dashboardText = readFileSync(
        join(projectRoot, generated.paths[1]),
        "utf-8",
      );
      expect(parseAppDocument(appText).errors).toEqual([]);
      expect(parseDashboardDocument(dashboardText).errors).toEqual([]);

      const app = JSON.parse(appText);
      expect(app.visibility).toBe("private");
      expect(app.publicationIntent).toBe("shared_project");

      const dashboard = JSON.parse(dashboardText);
      expect(dashboard.layout.items.every((item: { block?: unknown }) => Boolean(item.block))).toBe(true);
      expect(dashboard.layout.items.some((item: { text?: unknown }) => Boolean(item.text))).toBe(false);
      expect(dashboard.layout.items).toHaveLength(plan.pages[0].tiles.length);
      expect(dashboard.layout.items.some((item: any) => item.text)).toBe(false);
      expect(
        dashboard.layout.items.some((item: any) =>
          ["BusinessBrief", "NarrativePanel", "ResearchActions", "TrustCallout"].includes(
            item.viz?.options?.dqlGenUi?.component,
          ),
        ),
      ).toBe(false);
      expect(dashboard.layout.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            block: { blockId: "revenue_total" },
            sourceClass: "certified_block",
            review: expect.objectContaining({ status: "not_required" }),
            display: expect.objectContaining({
              mode: "block_hint",
              component: expect.any(String),
              trustState: "certified",
              reviewStatus: "certified",
              allowedVisualizations: expect.arrayContaining(["table"]),
            }),
            viz: expect.objectContaining({
              options: expect.objectContaining({
                dqlGenUi: expect.objectContaining({
                  version: 1,
                  trustState: "certified",
                }),
              }),
            }),
          }),
        ]),
      );
      expect(dashboard.layout.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            i: "revenue-total",
            block: { blockId: "revenue_total" },
          }),
        ]),
      );
      const readme = readFileSync(
        join(projectRoot, generated.paths[2]),
        "utf-8",
      );
      expect(readme).toContain("## Planner brief");
      expect(readme).toContain("## Certified context");
      expect(readme).toContain("## Scoped analysis memos");
      expect(readme).toContain("- Review-required dashboard tiles: 0");
      expect(readme).toContain("- Scoped analysis memos:");
      expect(readme).not.toMatch(/Review backlog|review backlog/i);
    }));

  it("writes generated apps globally with domain backlinks when a domain folder exists", () =>
    withKg(revenueNodes, (kg, dir) => {
      const projectRoot = join(dir, "project");
      mkdirSync(join(projectRoot, "domains", "growth"), { recursive: true });
      const plan = planAppFromPrompt({
        prompt: "Build a weekly revenue health app for the COO",
        kg,
        owner: "ops@example.com",
        domain: "growth",
      });

      const generated = generateAppFromPlan(projectRoot, plan, kg);

      expect(generated.paths).toEqual([
        `apps/${plan.appId}/dql.app.json`,
        `apps/${plan.appId}/dashboards/overview.dqld`,
        `apps/${plan.appId}/README.md`,
      ]);
      const parsed = parseAppDocument(readFileSync(join(projectRoot, generated.paths[0]), "utf-8"));
      expect(parsed.errors).toEqual([]);
      expect(parsed.document).toMatchObject({ ownerDomain: 'growth', usesDomains: ['growth'], requiredExports: [] });
      expect(parseDashboardDocument(readFileSync(join(projectRoot, generated.paths[1]), "utf-8")).errors).toEqual([]);
    }));

  it("writes a narrated story layout when a narration is supplied — with real numbers in the exec summary", () =>
    withKg(revenueNodes, (kg, dir) => {
      const projectRoot = join(dir, "project");
      const plan = planAppFromPrompt({
        prompt: "Build a weekly revenue health app for the COO",
        kg,
        owner: "ops@example.com",
      });

      const generated = generateAppFromPlan(projectRoot, plan, kg, {
        narration: {
          summary: "Weekly revenue reached $57,335 across 62 orders, led by returning customers.",
          keyFindings: [
            "Top customer lifetime spend is $57,335 across 62 orders.",
            "Returning customers drive the majority of revenue.",
          ],
          recommendation: "Review the returning-customer cohort before certifying.",
          source: "deterministic",
        },
      });

      const dashboardText = readFileSync(join(projectRoot, generated.paths[1]), "utf-8");
      const parsed = parseDashboardDocument(dashboardText);
      expect(parsed.errors).toEqual([]);
      const doc = parsed.document!;

      // Story sections exist and start with the exec summary.
      expect(doc.sections?.length).toBeGreaterThan(0);
      expect(doc.sections?.[0]).toMatchObject({ kind: "exec_summary", narrative: expect.stringContaining("$57,335") });

      // The narrated exec-summary tile leads the layout, full width, with the numbers.
      const execTile = doc.layout.items.find((item) => item.sectionId === "exec_summary");
      expect(execTile?.text?.markdown).toContain("$57,335");
      expect(execTile?.text?.markdown).toContain("**Next:**");
      expect(execTile?.w).toBe(12);

      // Every other tile is tagged into a real section.
      const sectionIds = new Set(doc.sections!.map((section) => section.id));
      expect(doc.layout.items.every((item) => item.sectionId && sectionIds.has(item.sectionId))).toBe(true);

      // Without narration the classic layout is unchanged (no sections at all).
      const plainPlan = { ...plan, appId: `${plan.appId}-plain` };
      const plain = generateAppFromPlan(projectRoot, plainPlan, kg);
      const plainDoc = parseDashboardDocument(readFileSync(join(projectRoot, plain.paths[1]), "utf-8")).document!;
      expect(plainDoc.sections).toBeUndefined();
      expect(plainDoc.layout.items.every((item) => item.sectionId === undefined)).toBe(true);
    }));
});

describe('humanTileTitle', () => {
  // A certified block's KG node name is its id, so AI-built tiles were all
  // labelled `monthly_revenue` / `beverage_revenue_by_product` — identifiers
  // that read as untouchable system fields rather than editable names.
  it('lifts the lead clause out of the block description', () => {
    expect(humanTileTitle('monthly_revenue', 'Monthly gross order revenue and order count. One row per calendar month.'))
      .toBe('Monthly gross order revenue and order count');
    expect(humanTileTitle('customer_profile', 'Customer lifetime profile. One row per customer.'))
      .toBe('Customer lifetime profile');
  });

  it('falls back to the de-slugged id when the lead clause will not fit a tile header', () => {
    expect(humanTileTitle('top_beverage_customers', 'Top customers ranked by beverage revenue, with beverage order count and product variety. One row per customer.'))
      .toBe('Top beverage customers');
  });

  it('falls back to the de-slugged id when there is no description', () => {
    expect(humanTileTitle('monthly_revenue')).toBe('Monthly revenue');
    expect(humanTileTitle('beverage_revenue_by_product', '')).toBe('Beverage revenue by product');
  });

  it('never returns a raw identifier when a readable form exists', () => {
    for (const [id, description] of [
      ['monthly_revenue', 'Monthly gross order revenue and order count.'],
      ['monthly_revenue', undefined],
      ['x', undefined],
    ] as Array<[string, string | undefined]>) {
      expect(humanTileTitle(id, description)).not.toContain('_');
    }
  });
});
