import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { QueryExecutor } from "@zlens/connectors";
import { NotebookDatasetWorkspace } from "./notebook-datasets.js";

class FakeExecutor {
  columns = [
    { column_name: "customer_id", column_type: "BIGINT", null: "NO" },
    { column_name: "revenue", column_type: "DOUBLE", null: "YES" },
  ];
  async executeQuery(sql: string) {
    if (sql.startsWith("DESCRIBE")) return { columns: [], rows: this.columns };
    if (sql.includes("COUNT(*) AS row_count"))
      return { columns: ["row_count"], rows: [{ row_count: 2 }] };
    if (sql.includes("LIMIT 100"))
      return {
        columns: this.columns.map((column) => column.column_name),
        rows: [
          { customer_id: 1, revenue: 10, segment: "A" },
          { customer_id: 2, revenue: 20, segment: "B" },
        ],
      };
    if (sql.startsWith("COPY")) {
      const target = /\bTO\s+'([^']+)'/i.exec(sql)?.[1];
      if (target) writeFileSync(target, "fake parquet");
    }
    return { columns: [], rows: [] };
  }
}

describe("notebook dataset workspace", () => {
  it("keeps local-only imports under .dql and profiles them", async () => {
    const root = mkdtempSync(join(tmpdir(), "dql-dataset-"));
    const workspace = new NotebookDatasetWorkspace(
      root,
      new FakeExecutor() as unknown as QueryExecutor,
    );
    const result = await workspace.import({
      filename: "customers.csv",
      contentBase64: Buffer.from("customer_id,revenue\n1,10\n2,20\n").toString(
        "base64",
      ),
    });
    expect(result.dataset.storageMode).toBe("local");
    expect(result.dataset.profile.rowCount).toBe(2);
    expect(result.dataset.sourcePath).toContain(".dql/local/datasets/");
    expect(workspace.list()).toHaveLength(1);
  });

  it("writes project-controlled metadata only when project storage is chosen", async () => {
    const root = mkdtempSync(join(tmpdir(), "dql-dataset-project-"));
    const workspace = new NotebookDatasetWorkspace(
      root,
      new FakeExecutor() as unknown as QueryExecutor,
    );
    await workspace.import({
      filename: "targets.csv",
      contentBase64: Buffer.from("customer_id,revenue\n1,10\n").toString(
        "base64",
      ),
      storageMode: "project",
    });
    expect(readFileSync(join(root, "data", "sources.yml"), "utf-8")).toContain(
      "project_controlled",
    );
  });

  it("deduplicates by fingerprint and supports type overrides, rename, and removal", async () => {
    const root = mkdtempSync(join(tmpdir(), "dql-dataset-lifecycle-"));
    const executor = new FakeExecutor();
    const workspace = new NotebookDatasetWorkspace(
      root,
      executor as unknown as QueryExecutor,
    );
    const input = {
      filename: "customers.csv",
      contentBase64: Buffer.from("customer_id,revenue\n1,10\n").toString(
        "base64",
      ),
    };
    const first = await workspace.import(input);
    const duplicate = await workspace.import(input);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.dataset.id).toBe(first.dataset.id);

    const updated = await workspace.updateSchema(first.dataset.id, {
      customer_id: "VARCHAR",
      revenue: "DECIMAL(18,2)",
      missing: "JSON",
    });
    expect(updated.schemaOverrides).toEqual({
      customer_id: "VARCHAR",
      revenue: "DECIMAL(18,2)",
    });
    const renamed = workspace.rename(
      first.dataset.id,
      "Customer planning file",
    );
    expect(renamed.name).toBe("Customer planning file");
    workspace.remove(first.dataset.id);
    expect(workspace.list()).toEqual([]);
  });

  it("detects schema drift on refresh and rebuilds registered views after restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "dql-dataset-refresh-"));
    const linked = join(root, "linked.csv");
    writeFileSync(linked, "customer_id,revenue\n1,10\n", "utf-8");
    const executor = new FakeExecutor();
    const workspace = new NotebookDatasetWorkspace(
      root,
      executor as unknown as QueryExecutor,
    );
    const imported = await workspace.import({
      sourcePath: linked,
      filename: "linked.csv",
      link: true,
    });
    executor.columns.push({
      column_name: "segment",
      column_type: "VARCHAR",
      null: "YES",
    });
    writeFileSync(linked, "customer_id,revenue,segment\n1,10,A\n", "utf-8");
    const refreshed = await workspace.refresh(imported.dataset.id);
    expect(refreshed.schemaDrift?.added).toEqual(["segment"]);

    const restarted = new NotebookDatasetWorkspace(
      root,
      executor as unknown as QueryExecutor,
    );
    await restarted.initialize();
    expect(
      restarted
        .get(imported.dataset.id)
        ?.profile.columns.map((column) => column.name),
    ).toContain("segment");
  });

  it("materializes staged rows as an expiring review-required Parquet dataset", async () => {
    const root = mkdtempSync(join(tmpdir(), "dql-dataset-stage-"));
    const executor = new FakeExecutor();
    const workspace = new NotebookDatasetWorkspace(
      root,
      executor as unknown as QueryExecutor,
    );
    const dataset = await workspace.stageRows({
      name: "Warehouse snapshot",
      rows: [{ customer_id: 1, revenue: 10 }],
      lineage: {
        connectionName: "warehouse",
        query: "select 1",
        extractedAt: new Date().toISOString(),
      },
    });
    expect(dataset.storageMode).toBe("staged");
    expect(dataset.trustState).toBe("review_required");
    expect(dataset.expiresAt).toBeTruthy();
    expect(existsSync(join(root, dataset.sourcePath))).toBe(true);
  });
});
