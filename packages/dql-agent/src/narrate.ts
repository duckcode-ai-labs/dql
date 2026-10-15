/**
 * Narrate service — turns a *grounded, executed* query result into a stakeholder
 * story: a summary, key findings, an optional recommendation, and optional
 * per-item (per-tile) insight captions.
 *
 * It is provider-agnostic by design (mirrors `createLlmAgentRunPlanner`): callers
 * inject a plain text completion (`NarrateCompletion`); any parse/transport
 * failure — or no injected LLM at all — falls back to a deterministic narration
 * computed from the rows (totals, leader, concentration, range). That keeps
 * Research and App storytelling fast, offline, and always-grounded: narration
 * only ever describes data the loop already executed against governed sources.
 */

import { nonMeasureColumnRole } from '@zlens/core';

export interface NarrateResultData {
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

export interface NarrateItem {
  id: string;
  title: string;
  result?: NarrateResultData;
}

export interface NarrateInput {
  question: string;
  intent?: string;
  result?: NarrateResultData;
  /** Per-tile results, for App storytelling captions. */
  items?: NarrateItem[];
  /** Governed sources/evidence used, surfaced to keep the narration grounded. */
  evidence?: string[];
  /** True when the underlying SQL is review-required (uncertified). */
  reviewRequired?: boolean;
}

export interface NarrateResult {
  summary: string;
  keyFindings: string[];
  recommendation?: string;
  /** Keyed by item id → one-line insight caption. */
  perItemInsight?: Record<string, string>;
  source: "llm" | "deterministic";
}

export type NarrateCompletion = (input: {
  system: string;
  user: string;
  signal?: AbortSignal;
}) => Promise<string>;

export interface NarrateOptions {
  complete?: NarrateCompletion;
  signal?: AbortSignal;
  maxFindings?: number;
}

export async function narrateResult(input: NarrateInput, options: NarrateOptions = {}): Promise<NarrateResult> {
  const deterministic = deterministicNarrate(input, options.maxFindings ?? 4);
  if (!options.complete) return deterministic;
  try {
    const raw = await options.complete({
      system: buildNarrateSystemPrompt(input.reviewRequired ?? false),
      user: buildNarrateUserPrompt(input),
      signal: options.signal,
    });
    const parsed = parseNarration(raw);
    if (parsed) {
      return {
        summary: parsed.summary ?? deterministic.summary,
        keyFindings: parsed.keyFindings?.length ? parsed.keyFindings : deterministic.keyFindings,
        recommendation: parsed.recommendation ?? deterministic.recommendation,
        // Per-item captions are computed deterministically from each tile's rows
        // unless the model supplied them; keep deterministic as the floor.
        perItemInsight: { ...deterministic.perItemInsight, ...(parsed.perItemInsight ?? {}) },
        source: "llm",
      };
    }
  } catch {
    // fall through to deterministic
  }
  return deterministic;
}

// ---------- deterministic narration ----------

function deterministicNarrate(input: NarrateInput, maxFindings: number): NarrateResult {
  const result = input.result;
  const rows = result?.rows ?? [];
  const perItemInsight = buildPerItemInsight(input.items);

  if (rows.length === 0) {
    return {
      summary: `No rows were returned for "${truncate(input.question, 80)}".`,
      keyFindings: [],
      perItemInsight,
      source: "deterministic",
    };
  }

  const { label, value } = pickColumns(result!);
  const findings: string[] = [];

  if (value) {
    const ranked = [...rows]
      .map((row) => ({ label: label ? formatCell(row[label]) : "row", value: toNumber(row[value]) }))
      .filter((entry) => entry.value !== undefined) as Array<{ label: string; value: number }>;
    ranked.sort((a, b) => b.value - a.value);
    const total = ranked.reduce((sum, entry) => sum + entry.value, 0);
    const top = ranked[0];

    let summary = `${rows.length} ${label ?? "row"}${rows.length === 1 ? "" : "s"} analyzed`;
    if (top) {
      summary += `: ${top.label} leads ${value} at ${formatNumber(top.value)}`;
      if (total > 0) summary += ` (${formatPct(top.value / total)})`;
      summary += ".";
      findings.push(`${top.label} is the largest ${label ?? "entry"} at ${formatNumber(top.value)}${total > 0 ? ` (${formatPct(top.value / total)} of ${value})` : ""}.`);
    }
    if (total > 0 && ranked.length >= 3) {
      const topThree = ranked.slice(0, 3).reduce((sum, entry) => sum + entry.value, 0);
      findings.push(`Top 3 ${label ?? "entries"} are ${formatPct(topThree / total)} of ${value} — concentration to watch.`);
    }
    const bottom = ranked[ranked.length - 1];
    if (bottom && ranked.length >= 4 && bottom.label !== top?.label) {
      findings.push(`${bottom.label} is the smallest at ${formatNumber(bottom.value)}.`);
    }
  } else {
    findings.push(`${rows.length} rows returned across columns: ${(result?.columns ?? []).slice(0, 6).join(", ")}.`);
  }

  return {
    summary: findings[0] ? findings[0] : `${rows.length} rows returned for "${truncate(input.question, 80)}".`,
    keyFindings: findings.slice(0, maxFindings),
    perItemInsight,
    source: "deterministic",
  };
}

function buildPerItemInsight(items?: NarrateItem[]): Record<string, string> | undefined {
  if (!items?.length) return undefined;
  const out: Record<string, string> = {};
  for (const item of items) {
    const rows = item.result?.rows ?? [];
    if (rows.length === 0) continue;
    const { label, value } = pickColumns(item.result!);
    if (!value) {
      out[item.id] = `${rows.length} rows.`;
      continue;
    }
    const ranked = rows
      .map((row) => ({ label: label ? formatCell(row[label]) : "row", value: toNumber(row[value]) }))
      .filter((entry) => entry.value !== undefined) as Array<{ label: string; value: number }>;
    ranked.sort((a, b) => b.value - a.value);
    const total = ranked.reduce((sum, entry) => sum + entry.value, 0);
    const top = ranked[0];
    if (!top) continue;
    out[item.id] = total > 0
      ? `${top.label} leads at ${formatNumber(top.value)} (${formatPct(top.value / total)}).`
      : `${top.label} leads at ${formatNumber(top.value)}.`;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function pickColumns(result: NarrateResultData): { label?: string; value?: string } {
  const columns = result.columns ?? [];
  const sample = result.rows?.[0] ?? {};
  let value: string | undefined;
  let label: string | undefined;
  // A rank, an id or a year is numeric and still a label: never the value.
  for (const column of columns) {
    if (value === undefined && toNumber(sample[column]) !== undefined && nonMeasureColumnRole(column) === undefined) value = column;
  }
  for (const column of columns) {
    if (column !== value && typeof sample[column] === "string") { label = column; break; }
  }
  if (!label) label = columns.find((column) => column !== value);
  return { label, value };
}

// ---------- LLM path ----------

function buildNarrateSystemPrompt(reviewRequired: boolean): string {
  return [
    "You explain analytics results to a business stakeholder in plain terms.",
    "Given a question and the executed result, write a short story: a one-sentence summary, 2-4 key",
    "findings (numbers + what they mean), and an optional one-line recommendation.",
    "Only describe what the data shows — never invent numbers or sources.",
    reviewRequired
      ? "This result is review-required (uncertified); keep claims cautious and directional."
      : "This result is from certified, governed data.",
    "Respond with ONLY a JSON object, no prose, no code fences:",
    '{"summary": string, "keyFindings": string[], "recommendation"?: string}',
  ].join("\n");
}

function buildNarrateUserPrompt(input: NarrateInput): string {
  const lines: string[] = [];
  lines.push(`Question: ${input.question}`);
  if (input.intent) lines.push(`Intent: ${input.intent}`);
  if (input.evidence?.length) lines.push(`Governed sources: ${input.evidence.join(", ")}`);
  if (input.result) {
    lines.push(`Columns: ${input.result.columns.join(", ")}`);
    const sample = input.result.rows.slice(0, 20);
    lines.push(`Rows (up to 20): ${JSON.stringify(sample)}`);
  }
  lines.push("Return the narration as JSON.");
  return lines.join("\n");
}

interface ParsedNarration {
  summary?: string;
  keyFindings?: string[];
  recommendation?: string;
  perItemInsight?: Record<string, string>;
}

function parseNarration(raw: string): ParsedNarration | undefined {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  const summary = typeof record.summary === "string" && record.summary.trim() ? record.summary.trim() : undefined;
  const keyFindings = Array.isArray(record.keyFindings)
    ? record.keyFindings.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : undefined;
  if (!summary && !keyFindings?.length) return undefined;
  const recommendation = typeof record.recommendation === "string" && record.recommendation.trim()
    ? record.recommendation.trim()
    : undefined;
  let perItemInsight: Record<string, string> | undefined;
  if (record.perItemInsight && typeof record.perItemInsight === "object" && !Array.isArray(record.perItemInsight)) {
    perItemInsight = {};
    for (const [key, val] of Object.entries(record.perItemInsight as Record<string, unknown>)) {
      if (typeof val === "string" && val.trim()) perItemInsight[key] = val.trim();
    }
  }
  return { summary, keyFindings, recommendation, perItemInsight };
}

function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = trimmed.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

// ---------- formatting (rounded; no float artifacts on screen) ----------

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const cleaned = value.replace(/[$,%\s]/g, "");
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) && cleaned.length > 0 ? parsed : undefined;
  }
  return undefined;
}

function formatNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatPct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return String(value);
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
