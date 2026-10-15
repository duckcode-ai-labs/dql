import { useCallback } from "react";
import { notebookStoreApi, useDispatch, makeCellId } from "../store/NotebookStore";
import { api, DqlApiError } from "../api/client";
import { substituteNotebookVariables } from "./useVariableSubstitution";
import type {
  Cell,
  NotebookCellExecutionEvidence,
  QueryResult,
} from "../store/types";
import { extractSqlFromText, parseDqlChartConfig } from "../utils/block-studio";
import {
  inferCellDependencies,
  planNotebookExecution,
} from "../utils/notebook-dependencies";
import {
  findDatasetReferences,
  findWarehouseReferences,
} from "../utils/dataset-references";
import { DQL_CELL_PLAIN_SQL_MESSAGE, dqlCellHoldsPlainSql } from "../utils/dql-cell-content";

interface RunningCellExecution {
  controller: AbortController;
  runId: string;
  startedAt: string;
  route: NotebookCellExecutionEvidence["route"];
  executionTarget?: Cell["executionTarget"];
}

export interface CellExecutionOutcome {
  cellId: string;
  runId?: string;
  status: "success" | "error" | "cancelled" | "blocked" | "skipped";
  result?: QueryResult;
  error?: string;
  execution?: NotebookCellExecutionEvidence;
}

// Process-wide because a cell can be rerun from the toolbar, keyboard shortcut,
// Run all, or a parameter update before an older React hook instance unmounts.
const runningExecutions = new Map<string, RunningCellExecution>();
const latestRunIds = new Map<string, string>();

function notebookCellRunId(cellId: string): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  return `cellrun_${cellId}_${random}`;
}

function extractSql(cell: Cell): string | null {
  if (cell.type === "markdown" || cell.type === "param") return null;
  if (cell.type === "sql") return cell.content.trim() || null;
  const dqlContent = cell.content.trim();
  return dqlContent ? extractSqlFromText(dqlContent) : null;
}

function normalizeServerChartConfig(
  value: unknown,
): Cell["chartConfig"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  return {
    ...(typeof raw.chart === "string" ? { chart: raw.chart } : {}),
    ...(typeof raw.x === "string" ? { x: raw.x } : {}),
    ...(typeof raw.y === "string" ? { y: raw.y } : {}),
    ...(typeof raw.color === "string" ? { color: raw.color } : {}),
    ...(typeof raw.title === "string" ? { title: raw.title } : {}),
  };
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function executionTargetOf(value: unknown): Cell["executionTarget"] | undefined {
  const target = recordOf(value);
  if (target?.target === "local") return { target: "local" };
  if (target?.target === "connection") {
    return {
      target: "connection",
      ...(typeof target.connectionName === "string"
        ? { connectionName: target.connectionName }
        : {}),
    };
  }
  return undefined;
}

function notebookPreflightError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): DqlApiError {
  return new DqlApiError({
    status: 400,
    code,
    message,
    recoverable: true,
    details: {
      phase: "preflight",
      ...details,
    },
  });
}

function errorEvidence(input: {
  cell: Cell;
  runId: string;
  route: NotebookCellExecutionEvidence["route"];
  startedAt: string;
  completedAt: string;
  durationMs: number;
  message: string;
  error?: unknown;
  status?: "error" | "cancelled" | "blocked";
  attemptedSql?: string;
}): NotebookCellExecutionEvidence {
  const apiError = input.error instanceof DqlApiError ? input.error : undefined;
  const details = recordOf(apiError?.details);
  const semanticTrace = recordOf(details?.semanticTrace);
  return {
    version: 1,
    runId: input.runId,
    cellId: input.cell.id,
    route: input.route,
    status: input.status ?? "error",
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: input.durationMs,
    executionTarget:
      input.cell.executionTarget ?? executionTargetOf(details?.executionTarget),
    compiledSql: input.attemptedSql,
    semanticTrace: semanticTrace as NotebookCellExecutionEvidence["semanticTrace"],
    targetBinding: recordOf(details?.targetBinding),
    executionReceipt: recordOf(details?.executionReceipt),
    error: {
      code: apiError?.code,
      phase: typeof details?.phase === "string" ? details.phase : "execution",
      message: input.message,
      details: apiError?.details,
    },
  };
}

function applyOutcomeToCells(
  cells: Cell[],
  outcome: CellExecutionOutcome,
): Cell[] {
  return cells.map((cell) => {
    if (cell.id !== outcome.cellId) return cell;
    if (outcome.status === "success") {
      return {
        ...cell,
        status: "success",
        result: outcome.result,
        error: undefined,
        execution: outcome.execution,
        executionCount: (cell.executionCount ?? 0) + 1,
        stale: false,
      };
    }
    if (
      outcome.status === "error"
      || outcome.status === "blocked"
      || outcome.status === "cancelled"
    ) {
      return {
        ...cell,
        status: outcome.status === "cancelled" ? "idle" : "error",
        result: undefined,
        error: outcome.status === "cancelled" ? undefined : outcome.error,
        execution: outcome.execution,
        executionCount: (cell.executionCount ?? 0) + 1,
        stale: false,
      };
    }
    return cell;
  });
}

export function useQueryExecution() {
  const dispatch = useDispatch();

  const executeCell = useCallback(
    async (
      cellId: string,
      scopedCells?: Cell[],
    ): Promise<CellExecutionOutcome> => {
      const runtimeState = notebookStoreApi.getState();
      const cells = scopedCells ?? runtimeState.cells;
      const cell = cells.find((candidate) => candidate.id === cellId);
      if (!cell) return { cellId, status: "skipped" };

      const route: NotebookCellExecutionEvidence["route"] =
        cell.type === "dql" ? "notebook_dql_cell" : "notebook_sql_cell";
      const rawSql = cell.type === "dql" ? null : extractSql(cell);
      if (cell.type !== "dql" && !rawSql) {
        return { cellId, status: "skipped" };
      }

      const previous = runningExecutions.get(cellId);
      if (previous) previous.controller.abort();

      const runId = notebookCellRunId(cellId);
      const startedAt = new Date().toISOString();
      const start = Date.now();
      const controller = new AbortController();
      const activeRun: RunningCellExecution = {
        controller,
        runId,
        startedAt,
        route,
        executionTarget: cell.executionTarget,
      };
      runningExecutions.set(cellId, activeRun);
      latestRunIds.set(cellId, runId);
      const isCurrent = () =>
        runningExecutions.get(cellId)?.runId === runId
        && latestRunIds.get(cellId) === runId;
      const nextCount = (cell.executionCount ?? 0) + 1;
      let attemptedSql = rawSql ?? undefined;

      dispatch({
        type: "UPDATE_CELL",
        id: cellId,
        updates: {
          status: "running",
          error: undefined,
          result: undefined,
          execution: undefined,
          fromSnapshot: false,
        },
      });

      const finishError = (
        message: string,
        error?: unknown,
        status: "error" | "cancelled" | "blocked" = "error",
      ): CellExecutionOutcome => {
        const completedAt = new Date().toISOString();
        const execution = errorEvidence({
          cell,
          runId,
          route,
          startedAt,
          completedAt,
          durationMs: Date.now() - start,
          message,
          error,
          status,
          attemptedSql,
        });
        if (isCurrent()) {
          dispatch({
            type: "UPDATE_CELL",
            id: cellId,
            updates: {
              status: status === "cancelled" ? "idle" : "error",
              error: status === "cancelled" ? undefined : message,
              result: undefined,
              execution,
              executionCount: nextCount,
              stale: false,
            },
          });
          dispatch({
            type: "APPEND_QUERY_LOG",
            entry: {
              id: makeCellId(),
              cellName: cell.name ?? cell.id,
              rows: 0,
              time: execution.durationMs,
              ts: new Date(),
              ...(status === "cancelled" ? {} : { error: message }),
            },
          });
        }
        return {
          cellId,
          runId,
          status,
          error: status === "cancelled" ? undefined : message,
          execution,
        };
      };

      try {
        if (cell.type === "dql" && dqlCellHoldsPlainSql(cell.content)) {
          // Plain SQL is not DQL; the cell offers a one-click switch to SQL.
          return finishError(DQL_CELL_PLAIN_SQL_MESSAGE);
        }
        if (cell.type === "dql") {
          const payload = await api.executeNotebookCell(
            cell,
            controller.signal,
            {
              notebookPath: runtimeState.activeFile?.path,
              cellId: cell.id,
              cellName: cell.name,
              source: route,
              runId,
            },
          );
          if (!payload.result) {
            throw new Error("DQL cell produced no executable result.");
          }
          if (!isCurrent()) {
            return { cellId, runId, status: "cancelled" };
          }
          const completedAt = new Date().toISOString();
          const durationMs = Date.now() - start;
          const result: QueryResult = {
            ...payload.result,
            executionTime: payload.result.executionTime ?? durationMs,
            rowCount:
              payload.result.rowCount ?? payload.result.rows.length,
          };
          const chartConfig =
            normalizeServerChartConfig(payload.chartConfig)
            ?? parseDqlChartConfig(cell.content);
          const execution: NotebookCellExecutionEvidence = {
            version: 1,
            runId,
            cellId,
            route,
            status: "success",
            startedAt,
            completedAt,
            durationMs,
            executionTarget:
              payload.executionTarget ?? cell.executionTarget,
            engine: payload.engine,
            compiledSql: payload.compiledSql,
            executedSql: payload.executedSql,
            semanticTrace: payload.semanticTrace,
            targetBinding: payload.targetBinding,
            executionReceipt: payload.executionReceipt,
          };
          dispatch({
            type: "UPDATE_CELL",
            id: cellId,
            updates: {
              status: "success",
              result,
              error: undefined,
              execution,
              executionTarget:
                payload.executionTarget ?? cell.executionTarget,
              ...(chartConfig ? { chartConfig } : {}),
              executionCount: nextCount,
              stale: false,
            },
          });
          dispatch({
            type: "APPEND_QUERY_LOG",
            entry: {
              id: makeCellId(),
              cellName: payload.blockName ?? cell.name ?? cell.id,
              rows: result.rowCount ?? result.rows.length,
              time: result.executionTime ?? durationMs,
              ts: new Date(),
            },
          });
          setTimeout(() => {
            if (latestRunIds.get(cellId) !== runId) return;
            dispatch({
              type: "UPDATE_CELL",
              id: cellId,
              updates: { status: "idle" },
            });
            latestRunIds.delete(cellId);
          }, 2000);
          return {
            cellId,
            runId,
            status: "success",
            result,
            execution,
          };
        }

        const referencedDatasets = findDatasetReferences(
          rawSql!,
          runtimeState.schemaTables,
        );
        const referencedWarehouseTables = findWarehouseReferences(
          rawSql!,
          runtimeState.schemaTables,
        );
        if (
          referencedDatasets.length > 0
          && referencedWarehouseTables.length > 0
        ) {
          const message = [
            `Mixed-source query detected: ${referencedWarehouseTables.join(", ")} runs in the warehouse, while ${referencedDatasets.map((dataset) => dataset.alias ?? dataset.id).join(", ")} is local data.`,
            "Direct cross-engine joins are not executed. Run the warehouse-only extraction first, then choose Combine with local data on its result.",
          ].join(" ");
          return finishError(
            message,
            notebookPreflightError("CROSS_ENGINE_JOIN_REQUIRED", message, {
              warehouseTables: referencedWarehouseTables,
              datasets: referencedDatasets.map((dataset) => dataset.alias ?? dataset.id),
            }),
          );
        }
        const executionTarget = referencedDatasets.length > 0
          ? { target: "local" as const }
          : cell.executionTarget;
        if (
          referencedDatasets.length > 0
          && cell.executionTarget?.target !== "local"
        ) {
          dispatch({
            type: "UPDATE_CELL",
            id: cellId,
            updates: { executionTarget, datasetRefs: referencedDatasets },
          });
        }

        const substitution = substituteNotebookVariables(rawSql!, cells);
        if (substitution.ambiguous.length > 0) {
          const message =
            `Ambiguous notebook dependency: ${substitution.ambiguous.join(", ")} matches more than one cell. Rename the duplicate cells or reference a stable cell ID.`;
          return finishError(
            message,
            notebookPreflightError("AMBIGUOUS_NOTEBOOK_DEPENDENCY", message, {
              ambiguousReferences: substitution.ambiguous,
            }),
          );
        }
        if (substitution.unresolved.length > 0) {
          const message =
            `Notebook dependency result is unavailable: ${substitution.unresolved.join(", ")}. Run or repair the upstream cell before retrying this cell.`;
          return finishError(
            message,
            notebookPreflightError("UPSTREAM_RESULT_UNAVAILABLE", message, {
              unresolvedReferences: substitution.unresolved,
            }),
          );
        }

        attemptedSql = substitution.sql;

        const resultPayload = await api.executeQuery(
          substitution.sql,
          controller.signal,
          {
            notebookPath: runtimeState.activeFile?.path,
            cellId: cell.id,
            cellName: cell.name,
            source: route,
            runId,
          },
          executionTarget,
        );
        if (!isCurrent()) {
          return { cellId, runId, status: "cancelled" };
        }
        const completedAt = new Date().toISOString();
        const durationMs = Date.now() - start;
        const {
          executionTarget: responseExecutionTarget,
          compiledSql,
          executedSql,
          targetBinding,
          executionReceipt,
          ...queryResult
        } = resultPayload;
        const result: QueryResult = {
          ...queryResult,
          executionTime: queryResult.executionTime ?? durationMs,
          rowCount: queryResult.rowCount ?? queryResult.rows.length,
        };
        const datasetRefs = executionTarget?.target === "local"
          ? findDatasetReferences(substitution.sql, runtimeState.schemaTables)
          : cell.datasetRefs;
        const execution: NotebookCellExecutionEvidence = {
          version: 1,
          runId,
          cellId,
          route,
          status: "success",
          startedAt,
          completedAt,
          durationMs,
          executionTarget: responseExecutionTarget ?? executionTarget,
          compiledSql: compiledSql ?? substitution.sql,
          executedSql: executedSql ?? substitution.sql,
          targetBinding,
          executionReceipt,
        };
        dispatch({
          type: "UPDATE_CELL",
          id: cellId,
          updates: {
            status: "success",
            result,
            error: undefined,
            execution,
            executionCount: nextCount,
            stale: false,
            datasetRefs,
            executionTarget: responseExecutionTarget ?? executionTarget,
          },
        });
        dispatch({
          type: "APPEND_QUERY_LOG",
          entry: {
            id: makeCellId(),
            cellName: cell.name ?? cell.id,
            rows: result.rowCount ?? result.rows.length,
            time: result.executionTime ?? durationMs,
            ts: new Date(),
          },
        });
        setTimeout(() => {
          if (latestRunIds.get(cellId) !== runId) return;
          dispatch({
            type: "UPDATE_CELL",
            id: cellId,
            updates: { status: "idle" },
          });
          latestRunIds.delete(cellId);
        }, 2000);
        return {
          cellId,
          runId,
          status: "success",
          result,
          execution,
        };
      } catch (error) {
        if (controller.signal.aborted || !isCurrent()) {
          return finishError("Cell execution was cancelled.", error, "cancelled");
        }
        const message = error instanceof Error ? error.message : String(error);
        return finishError(message, error);
      } finally {
        if (runningExecutions.get(cellId)?.runId === runId) {
          runningExecutions.delete(cellId);
        }
      }
    },
    [dispatch],
  );

  const executeAll = useCallback(async () => {
    const cellsAtStart = notebookStoreApi.getState().cells;
    const plan = planNotebookExecution(cellsAtStart);
    let workingCells = cellsAtStart.map((cell) => ({ ...cell }));
    const outcomes = new Map<string, CellExecutionOutcome>();
    const missingByCell = new Map<string, string[]>();
    for (const missing of plan.missing) {
      missingByCell.set(missing.cellId, [
        ...(missingByCell.get(missing.cellId) ?? []),
        missing.dependency,
      ]);
    }

    for (const cellId of plan.cycleCellIds) {
      const cell = workingCells.find((candidate) => candidate.id === cellId);
      if (!cell) continue;
      const runId = notebookCellRunId(cellId);
      const now = new Date().toISOString();
      const message =
        "Dependency cycle detected. Update the cell dependencies before running all.";
      const execution = errorEvidence({
        cell,
        runId,
        route:
          cell.type === "dql" ? "notebook_dql_cell" : "notebook_sql_cell",
        startedAt: now,
        completedAt: now,
        durationMs: 0,
        message,
        error: notebookPreflightError("DEPENDENCY_CYCLE", message, {
          cycleCellIds: plan.cycleCellIds,
        }),
        status: "blocked",
      });
      const outcome: CellExecutionOutcome = {
        cellId,
        runId,
        status: "blocked",
        error: message,
        execution,
      };
      outcomes.set(cellId, outcome);
      workingCells = applyOutcomeToCells(workingCells, outcome);
      dispatch({
        type: "UPDATE_CELL",
        id: cellId,
        updates: {
          status: "error",
          error: message,
          result: undefined,
          execution,
          executionCount: (cell.executionCount ?? 0) + 1,
          stale: false,
        },
      });
    }

    for (const plannedCell of plan.ordered) {
      const cell =
        workingCells.find((candidate) => candidate.id === plannedCell.id)
        ?? plannedCell;
      const missing = missingByCell.get(cell.id) ?? [];
      const failedDependencies = inferCellDependencies(
        cell,
        workingCells,
      ).filter((dependency) => {
        const outcome = outcomes.get(dependency.cellId);
        return outcome && outcome.status !== "success";
      });
      if (missing.length > 0 || failedDependencies.length > 0) {
        const blockedBy = [
          ...missing,
          ...failedDependencies.map(
            (dependency) =>
              workingCells.find(
                (candidate) => candidate.id === dependency.cellId,
              )?.name ?? dependency.cellId,
          ),
        ];
        const runId = notebookCellRunId(cell.id);
        const now = new Date().toISOString();
        const message =
          `Not executed because ${blockedBy.join(", ")} did not produce a valid upstream result.`;
        const execution = errorEvidence({
          cell,
          runId,
          route:
            cell.type === "dql" ? "notebook_dql_cell" : "notebook_sql_cell",
          startedAt: now,
          completedAt: now,
          durationMs: 0,
          message,
          error: notebookPreflightError("UPSTREAM_EXECUTION_FAILED", message, {
            blockedBy,
          }),
          status: "blocked",
        });
        const outcome: CellExecutionOutcome = {
          cellId: cell.id,
          runId,
          status: "blocked",
          error: message,
          execution,
        };
        outcomes.set(cell.id, outcome);
        workingCells = applyOutcomeToCells(workingCells, outcome);
        dispatch({
          type: "UPDATE_CELL",
          id: cell.id,
          updates: {
            status: "error",
            error: message,
            result: undefined,
            execution,
            executionCount: (cell.executionCount ?? 0) + 1,
            stale: false,
          },
        });
        continue;
      }
      const outcome = await executeCell(cell.id, workingCells);
      outcomes.set(cell.id, outcome);
      workingCells = applyOutcomeToCells(workingCells, outcome);
    }
  }, [dispatch, executeCell]);

  const executeDependents = useCallback(
    async (paramName: string) => {
      if (!paramName) return;
      const pattern = `{{${paramName}}}`;
      let workingCells = notebookStoreApi.getState().cells.map((cell) => ({ ...cell }));
      for (const cell of workingCells) {
        if (
          cell.type === "markdown"
          || cell.type === "param"
          || !cell.content.includes(pattern)
        ) {
          continue;
        }
        const outcome = await executeCell(cell.id, workingCells);
        workingCells = applyOutcomeToCells(workingCells, outcome);
      }
    },
    [executeCell],
  );

  const cancelCell = useCallback(
    (cellId: string) => {
      const running = runningExecutions.get(cellId);
      if (!running) return;
      running.controller.abort();
      runningExecutions.delete(cellId);
      if (latestRunIds.get(cellId) === running.runId) {
        latestRunIds.delete(cellId);
      }
      const completedAt = new Date().toISOString();
      const cell = notebookStoreApi.getState().cells.find(
        (candidate) => candidate.id === cellId,
      );
      dispatch({
        type: "UPDATE_CELL",
        id: cellId,
        updates: {
          status: "idle",
          error: undefined,
          result: undefined,
          ...(cell
            ? {
                execution: errorEvidence({
                  cell,
                  runId: running.runId,
                  route: running.route,
                  startedAt: running.startedAt,
                  completedAt,
                  durationMs:
                    Date.parse(completedAt) - Date.parse(running.startedAt),
                  message: "Cell execution was cancelled.",
                  status: "cancelled",
                }),
                executionCount: (cell.executionCount ?? 0) + 1,
              }
            : {}),
        },
      });
    },
    [dispatch],
  );

  return { executeCell, executeAll, executeDependents, cancelCell };
}
