import { describe, it, expect } from "vitest";
import { parse, type DQLManifest, type MetricCapabilityContract } from "@zlens/core";
import { certifiedBlockProvesRequestedTopN, certifiedBlockDeclaresQualifiers, renderContextValidationRefusalForUser, parseProposal, compactSemanticRuntimeFailure, normalizeWarehouseSqlFailure } from "./answer-loop.js";
import { analyticalError } from "./analytical-error.js";
import { buildAnalysisQuestionPlan, type CertifiedBlockApplicability } from "./metadata/analysis-planner.js";
import type { CertifiedBlockFit } from "./metadata/block-fit.js";
import type { KGNode } from "./kg/types.js";

function certifiedRevenueTopNBlock(limitExpression: string): KGNode {
  return {
    nodeId: "block:certified_revenue_top_n",
    kind: "block",
    name: "certified_revenue_top_n",
    status: "certified",
    declaredOutputs: ["customer_name", "revenue"],
    dimensions: ["customer_name"],
    parameters: [{
      name: "top_n",
      type: "number",
      required: false,
      policy: "dynamic",
      binding: { kind: "limit" },
    }],
    sql: [
      "SELECT customer_name, SUM(revenue) AS revenue",
      "FROM customer_revenue",
      "GROUP BY customer_name",
      "ORDER BY revenue DESC",
      `LIMIT ${limitExpression}`,
    ].join("\n"),
  };
}

describe("certified top-N DQL interpolation proof", () => {
  const revenuePlan = buildAnalysisQuestionPlan("who are the top 3 customers by revenue");
  const implicitCustomerPlan = buildAnalysisQuestionPlan("who are the top customers");

  it("accepts the DQL ${name} interpolation", () => {
    expect(certifiedBlockProvesRequestedTopN(
      certifiedRevenueTopNBlock("${top_n}"),
      revenuePlan,
    )).toBe(true);
  });

  it("accepts the DQL {name} interpolation", () => {
    expect(certifiedBlockProvesRequestedTopN(
      certifiedRevenueTopNBlock("{top_n}"),
      revenuePlan,
    )).toBe(true);
  });

  it("rejects a colon driver placeholder", () => {
    expect(certifiedBlockProvesRequestedTopN(
      certifiedRevenueTopNBlock(":top_n"),
      revenuePlan,
    )).toBe(false);
  });

  it("rejects a dollar driver placeholder", () => {
    expect(certifiedBlockProvesRequestedTopN(
      certifiedRevenueTopNBlock("$top_n"),
      revenuePlan,
    )).toBe(false);
  });

  it("rejects bare, fixed, and compound LIMIT expressions", () => {
    for (const expression of ["top_n", "10", "${top_n} + 1"]) {
      expect(certifiedBlockProvesRequestedTopN(
        certifiedRevenueTopNBlock(expression),
        revenuePlan,
      )).toBe(false);
    }
  });

  it("allows an authored primary metric only for a host-proven exact implicit certified question", () => {
    const block = certifiedRevenueTopNBlock("${top_n}");
    expect(certifiedBlockProvesRequestedTopN(block, implicitCustomerPlan)).toBe(false);
    expect(certifiedBlockProvesRequestedTopN(block, implicitCustomerPlan, {
      exactCertifiedQuestionMatch: true,
    })).toBe(true);
  });

  it("allows a unique snapshot-complete implicit certified fit when the host freezes the outer row bound", () => {
    // Mirrors the real commerce::block::customer_profile contract: its
    // authored query ranks lifetime spend, but intentionally leaves limiting
    // to the governed execution invocation rather than a block parameter.
    const block: KGNode = {
      nodeId: "block:customer_profile",
      kind: "block",
      name: "customer_profile",
      domain: "commerce",
      status: "certified",
      declaredOutputs: [
        "customer_name",
        "customer_type",
        "count_lifetime_orders",
        "lifetime_spend",
        "first_ordered_at",
        "last_ordered_at",
      ],
      dimensions: ["customer_name", "customer_type"],
      sql: [
        "SELECT customer_name, customer_type, count_lifetime_orders, lifetime_spend, first_ordered_at, last_ordered_at",
        "FROM dev.customers",
        "ORDER BY lifetime_spend DESC, customer_name",
      ].join("\n"),
    };

    expect(certifiedBlockProvesRequestedTopN(block, implicitCustomerPlan)).toBe(false);
    expect(certifiedBlockProvesRequestedTopN(block, implicitCustomerPlan, {
      uniqueCompleteCertifiedFit: true,
      hostEnforcedRowLimit: 10,
    })).toBe(true);
    expect(certifiedBlockProvesRequestedTopN(block, implicitCustomerPlan, {
      uniqueCompleteCertifiedFit: true,
      hostEnforcedRowLimit: 3,
    })).toBe(false);
  });
});

describe("parseProposal", () => {
  it("extracts a structured JSON proposal from a fenced object", () => {
    const raw = [
      "```json",
      JSON.stringify({
        summary: "Revenue by region at region grain.",
        sql: "SELECT region, SUM(amount) AS revenue FROM orders GROUP BY region",
        viz: "bar",
        outputs: ["region", "revenue"],
      }),
      "```",
    ].join("\n");
    expect(parseProposal(raw)).toEqual({
      text: "Revenue by region at region grain.",
      sql: "SELECT region, SUM(amount) AS revenue FROM orders GROUP BY region",
      viz: "bar",
      outputs: ["region", "revenue"],
    });
  });

  it("extracts DQL metadata from a structured JSON proposal", () => {
    const raw = [
      "```json",
      JSON.stringify({
        summary: "Product supply value at product and supply grain.",
        sql: "SELECT product_name, supply_name, SUM(order_value) AS total_value FROM product_supply_orders GROUP BY product_name, supply_name",
        viz: "table",
        outputs: ["product_name", "supply_name", "total_value"],
        dql: {
          entity: "product_supply",
          dimensions: ["product_name", "supply_name", "product_name"],
          filters: ["top 10 by total_value", "top 10 by total_value"],
        },
      }),
      "```",
    ].join("\n");
    expect(parseProposal(raw)).toEqual({
      text: "Product supply value at product and supply grain.",
      sql: "SELECT product_name, supply_name, SUM(order_value) AS total_value FROM product_supply_orders GROUP BY product_name, supply_name",
      viz: "table",
      outputs: ["product_name", "supply_name", "total_value"],
      proposedEntity: "product_supply",
      requestedDimensions: ["product_name", "supply_name"],
      requestedFilters: ["top 10 by total_value"],
    });
  });

  it("extracts a structured JSON proposal from a raw object", () => {
    const raw = JSON.stringify({
      answer: "One KPI row.",
      query: "SELECT COUNT(*) AS order_count FROM orders",
      visualization: "single_value",
    });
    expect(parseProposal(raw)).toEqual({
      text: "One KPI row.",
      sql: "SELECT COUNT(*) AS order_count FROM orders",
      viz: "single_value",
    });
  });

  it("extracts SQL block + viz line + summary text", () => {
    const raw = "Revenue summary.\n\n```sql\nSELECT 1\n```\n\nViz: line";
    expect(parseProposal(raw)).toEqual({
      text: "Revenue summary.",
      sql: "SELECT 1",
      viz: "line",
    });
  });

  it("handles missing viz line", () => {
    const raw = "No viz hint.\n\n```sql\nSELECT 2\n```";
    expect(parseProposal(raw)).toEqual({
      text: "No viz hint.",
      sql: "SELECT 2",
      viz: undefined,
    });
  });

  it("returns sql=undefined when there is no fenced SQL block", () => {
    const raw = "I refuse";
    const parsed = parseProposal(raw);
    expect(parsed.sql).toBeUndefined();
    expect(parsed.text).toBe("I refuse");
  });

  it("falls back to the legacy SQL parser when JSON is malformed", () => {
    const raw = '```json\n{"summary": "bad"\n```\n\nFallback summary.\n```sql\nSELECT 3\n```\nViz: table';
    expect(parseProposal(raw)).toEqual({
      text: "Fallback summary.",
      sql: "SELECT 3",
      viz: "table",
    });
  });
});

describe("normalizeWarehouseSqlFailure", () => {
  it("preserves safe Snowflake diagnostics and chooses dialect repair for syntax failures", () => {
    const failure = normalizeWarehouseSqlFailure(Object.assign(
      new Error("SQL compilation error: syntax error line 3 at position 7 unexpected 'QUALIFY'"),
      {
        driver: "snowflake",
        vendorCode: "001003",
        sqlState: "42000",
        queryId: "01b-query",
        line: 3,
        position: 7,
        retryable: false,
      },
    ));
    expect(failure).toMatchObject({
      category: "syntax",
      retryDisposition: "model_repair",
      driver: "snowflake",
      vendorCode: "001003",
      sqlState: "42000",
      queryId: "01b-query",
      line: 3,
      position: 7,
    });
  });

  it.each([
    ["Object ORDERS does not exist", "unknown_relation", "refresh_metadata"],
    ['Schema \'DEV_KKONDAPAKA_TRANSFORMED."sales"\' does not exist or not authorized', "unknown_relation", "refresh_metadata"],
    ["Statement timed out after 60 seconds", "timeout", "explicit_retry"],
    ["Authentication failed: token=super-secret", "authentication", "change_authorized_access"],
    ["Unsafe statement: DELETE is not read-only", "unsafe", "terminal"],
    ["Connection reset by peer", "connection", "explicit_retry"],
    ["Unable to perform operation using terminated connection", "connection", "explicit_retry"],
  ])("classifies %s without creating a noisy retry loop", (message, category, disposition) => {
    const failure = normalizeWarehouseSqlFailure(message, "snowflake");
    expect(failure.category).toBe(category);
    expect(failure.retryDisposition).toBe(disposition);
    expect(failure.redactedMessage).not.toContain("super-secret");
  });
});

describe("compactSemanticRuntimeFailure", () => {
  it("reduces a MetricFlow group-by resolver dump to one actionable sentence", () => {
    const raw = `MetricFlow compile failed (1): ERROR: Got error(s) during query resolution.
Error #1: Message:
The given input does not match any of the available group-by-items for SimpleMetric('total_bcm'). Common issues are:
    Incorrect names.
Suggestions: [ 'bcm_hdr__effective_customer_account_name', 'bcm_hdr__customer_account_id', ]
Query Input:
effective_customer_account_name
Log File:: /Users/u/dbt/logs/metricflow.log`;
    const compact = compactSemanticRuntimeFailure(raw);
    expect(compact).toContain("could not group total_bcm");
    expect(compact).toContain('"effective_customer_account_name"');
    expect(compact).toContain("bcm_hdr__effective_customer_account_name");
    expect(compact.length).toBeLessThan(400);
    expect(compact).not.toContain("Log File");
  });

  it("truncates other long failures to their first line", () => {
    const compact = compactSemanticRuntimeFailure(`database timeout after 30s\nstack line 1\nstack line 2`);
    expect(compact).toBe("database timeout after 30s");
  });
});

describe('aggregation refusal names the one check that fired', () => {
  const render = (codes?: string[]) =>
    renderContextValidationRefusalForUser('unsafe_aggregation', 'machine detail', undefined, codes);

  it('names a fan-out and what to do, not a menu of four causes', () => {
    // Reported shape: "rounding too early, losing decimal precision, summing a
    // non-additive value, or multiplying rows across a join" — a list of every
    // possible cause reads as "something is wrong somewhere".
    const text = render(['FANOUT']);
    expect(text).toContain('multiplies rows');
    expect(text).not.toContain('rounding too early');
    expect(text).toContain('Aggregate at the row-level grain first');
  });

  it('distinguishes the other three causes', () => {
    expect(render(['NON_ADDITIVE_MEASURE'])).toContain('not additive');
    expect(render(['PREMATURE_ROUNDING'])).toContain('rounds each value before adding');
    expect(render(['LOSSY_NUMERIC_CAST'])).toContain('floating point');
  });

  it('leads with the worst distortion when several fired', () => {
    expect(render(['PREMATURE_ROUNDING', 'FANOUT'])).toContain('multiplies rows');
  });

  it('says so plainly when no code reached it, rather than listing every cause', () => {
    const text = render([]);
    expect(text).toContain('would change how the metric is calculated');
    expect(text).not.toContain('rounding too early');
    expect(render(undefined)).toBe(text);
  });
});

describe('compactSemanticRuntimeFailure on a live MetricFlow dump', () => {
  it('drops the transport prefix and the upgrade nag and names the fix', () => {
    const live = "metricflow-cli semantic compilation failed: MetricFlow compile failed (1): ‼️ Warning: A new version of the MetricFlow CLI is available. 💡 Please update to version 0.14.0, released 2026-08-19 20:46:17 by running: $ pip install --upgrade dbt-metricflow ERROR: Got error(s) during query resolution. Error #1: Message: The given input does not match any of the available group-by-items for SimpleMetric('average_order_value').\n  Query Input:\n    'location_name'\n  Suggestions:\n    ['location__location_name', 'order_id__location_name']";
    const text = compactSemanticRuntimeFailure(live);
    expect(text).toContain('MetricFlow could not group average_order_value by "location_name"');
    expect(text).toContain('location__location_name');
    expect(text).not.toContain('Warning');
    expect(text).not.toContain('pip install');
  });

  it('falls back to the resolver message, not the nag, when no group-by shape matches', () => {
    const text = compactSemanticRuntimeFailure('MetricFlow compile failed (1): ‼️ Warning: A new version of the MetricFlow CLI is available. 💡 Please update by running: $ pip install --upgrade dbt-metricflow ERROR: Got error(s) during query resolution. Error #1: Message: Unable to resolve metric nope.');
    expect(text).toBe('Unable to resolve metric nope.');
  });
});

describe('certifiedBlockDeclaresQualifiers', () => {
  it('binds a qualifier the author declared in tags or outputs, and refuses one only the title carries', () => {
    const beverage = { tags: ['beverage', 'customer'], declaredOutputs: ['customer_name', 'beverage_revenue'], dimensions: ['customer_name'], entities: ['order_item'] };
    expect(certifiedBlockDeclaresQualifiers(beverage, ['beverage'])).toBe(true);
    expect(certifiedBlockDeclaresQualifiers(beverage, ['beverages'])).toBe(true);
    expect(certifiedBlockDeclaresQualifiers(beverage, ['bcm'])).toBe(false);
    const topCustomers = { tags: ['ranking'], declaredOutputs: ['customer_name', 'lifetime_spend'] };
    expect(certifiedBlockDeclaresQualifiers(topCustomers, ['bcm'])).toBe(false);
  });
});
