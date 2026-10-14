/**
 * Rendered App digests and monitor alerts (RFC 0008 step 10).
 *
 * A scheduled page run becomes a digest a reader can act on without opening
 * the App: the page's headline figures with their change since the last
 * scheduled run, what moved most, the monitors that fired and — when the
 * page has a driver tile — why the figure moved. Every figure is a bound
 * value from the governed run (the same catalog stories and snapshots use),
 * and each tile carries the reader's trust label.
 *
 * The last run's figures and each monitor's state are kept per schedule in
 * `.dql/local/digests` (values only, never rows) so the next run can say
 * what changed and how long an alert has been firing.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  evaluateMonitors,
  figureLabel,
  readerTileTrust,
  readerTrustSummary,
  type AppMonitor,
  type MonitorEvaluation,
  type ReaderTrustItem,
  type ReaderTrustTile,
  type StoryBindingCatalog,
} from '@zlens/core';
import type { AppPageRunTile } from './app-page-run.js';

export interface DigestState {
  runAt: string;
  values: Record<string, { value: number | string | null; display: string; label: string }>;
  /** When each monitor started firing; cleared when it stops. */
  firingSince: Record<string, string>;
}

const safe = (value: string) => `${value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60)}-${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;

export function digestStatePath(projectRoot: string, appId: string, scheduleId: string): string {
  return join(projectRoot, '.dql', 'local', 'digests', safe(appId), `${safe(scheduleId)}.json`);
}

export function readDigestState(projectRoot: string, appId: string, scheduleId: string): DigestState | null {
  const path = digestStatePath(projectRoot, appId, scheduleId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as DigestState;
    return parsed && typeof parsed === 'object' && parsed.values && typeof parsed.values === 'object'
      ? { runAt: String(parsed.runAt ?? ''), values: parsed.values, firingSince: parsed.firingSince ?? {} }
      : null;
  } catch {
    return null;
  }
}

export function writeDigestState(projectRoot: string, appId: string, scheduleId: string, state: DigestState): void {
  const path = digestStatePath(projectRoot, appId, scheduleId);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  renameSync(temp, path);
}

/** The layout item fields a digest reads. */
export interface DigestLayoutItem extends ReaderTrustItem {
  i: string;
  title?: string;
  viz?: { type?: string };
  driver?: { measure?: string };
}

export interface DigestInput {
  appTitle: string;
  pageTitle: string;
  items: DigestLayoutItem[];
  tiles: AppPageRunTile[];
  catalog: StoryBindingCatalog;
  monitors: AppMonitor[];
  previous: DigestState | null;
  runAt: string;
}

export interface DigestFigure {
  key: string;
  label: string;
  display: string;
  previous?: string;
  changePercent?: number;
}

export interface AppDigest {
  subject: string;
  markdown: string;
  html: string;
  evaluations: MonitorEvaluation[];
  firing: MonitorEvaluation[];
  headline: DigestFigure[];
  changes: DigestFigure[];
  trust: { certified: number; total: number; text: string };
  /** State to store for the next run. */
  nextState: DigestState;
}

const DERIVED = /\.(leader|leader_value|current|prior|change|change_percent|top_dimension|top_member|top_member_change)$/;
const SINGLE_VALUE = new Set(['kpi', 'single_value', 'gauge']);

const esc = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pct = (value: number) => `${Math.abs(value) >= 10 ? Math.round(Math.abs(value)) : Number(Math.abs(value).toFixed(1))}%`;
/** Blue up, orange down, always with an arrow (RFC 0008 colour rules). */
const arrow = (change: number) => (change > 0 ? '▲' : change < 0 ? '▼' : '■');
const changeText = (figure: DigestFigure) => (figure.changePercent === undefined
  ? ''
  : figure.changePercent === 0 ? 'no change' : `${arrow(figure.changePercent)} ${pct(figure.changePercent)} (was ${figure.previous})`);

function figureWithChange(catalog: StoryBindingCatalog, key: string, previous: DigestState | null): DigestFigure | null {
  const binding = catalog[key];
  if (!binding) return null;
  const before = previous?.values[key];
  const change = typeof binding.value === 'number' && typeof before?.value === 'number' && before.value !== 0
    ? ((binding.value - before.value) / Math.abs(before.value)) * 100
    : undefined;
  return {
    key,
    label: figureLabel(binding.label),
    display: binding.display,
    ...(before ? { previous: before.display } : {}),
    ...(change !== undefined ? { changePercent: change } : {}),
  };
}

/**
 * A driver tile on the page for the same measure. It explains the change the
 * driver was set up to compare, which may not be the alert's condition, so
 * it is shown as related context with its own title, never as the cause.
 */
function driverExplanation(evaluation: MonitorEvaluation, items: DigestLayoutItem[], tiles: AppPageRunTile[]): string | undefined {
  const field = evaluation.monitor.binding.split('.').slice(1).join('.').replace(/\[.*\]$/, '');
  const drivers = items.filter((item) => item.driver);
  const match = drivers.find((item) => item.driver?.measure === field) ?? (drivers.length === 1 ? drivers[0] : undefined);
  const tile = match ? tiles.find((candidate) => candidate.tileId === match.i) : undefined;
  const summary = (tile?.raw as { driver?: { summary?: unknown } } | undefined)?.driver?.summary;
  return tile?.status === 'ok' && typeof summary === 'string' && summary.trim()
    ? `From “${match!.title ?? match!.i}”: ${summary.trim()}`
    : undefined;
}

export function buildAppDigest(input: DigestInput): AppDigest {
  const byId = new Map(input.items.map((item) => [item.i, item]));
  const evaluations = evaluateMonitors(input.monitors, input.catalog, input.previous?.values ?? {});
  const firing = evaluations.filter((evaluation) => evaluation.status === 'breached');
  const firingSince: Record<string, string> = {};
  for (const evaluation of firing) firingSince[evaluation.monitor.id] = input.previous?.firingSince[evaluation.monitor.id] ?? input.runAt;

  // Headline figures: the value of each single-value tile, in page order.
  const headline = input.items
    .filter((item) => SINGLE_VALUE.has(String(item.viz?.type ?? '')))
    .flatMap((item) => {
      const key = Object.keys(input.catalog).find((candidate) => input.catalog[candidate]!.tileId === item.i && !candidate.includes('[') && !DERIVED.test(candidate) && input.catalog[candidate]!.kind === 'number');
      const figure = key ? figureWithChange(input.catalog, key, input.previous) : null;
      return figure ? [figure] : [];
    })
    .slice(0, 6);
  const headlineKeys = new Set(headline.map((figure) => figure.key));
  const changes = Object.keys(input.catalog)
    .filter((key) => !headlineKeys.has(key) && !DERIVED.test(key))
    .map((key) => figureWithChange(input.catalog, key, input.previous))
    .filter((figure): figure is DigestFigure => Boolean(figure && figure.changePercent !== undefined && figure.changePercent !== 0))
    .sort((left, right) => Math.abs(right.changePercent!) - Math.abs(left.changePercent!))
    .slice(0, 5);

  const dataTiles = input.tiles.filter((tile) => tile.tileType !== 'text' && !byId.get(tile.tileId)?.text);
  const trusts = dataTiles.map((tile) => readerTileTrust(byId.get(tile.tileId) ?? {}, (tile.raw ?? { status: tile.status, certificationStatus: tile.certificationStatus }) as unknown as ReaderTrustTile));
  const trust = readerTrustSummary(trusts);
  const failed = dataTiles.filter((tile) => tile.status !== 'ok');
  const drivers = dataTiles
    .filter((tile) => tile.status === 'ok' && byId.get(tile.tileId)?.driver)
    .flatMap((tile) => {
      const summary = (tile.raw as { driver?: { summary?: unknown } } | undefined)?.driver?.summary;
      return typeof summary === 'string' && summary.trim() ? [{ title: byId.get(tile.tileId)?.title ?? tile.title ?? tile.tileId, summary: summary.trim() }] : [];
    });
  const when = new Date(input.runAt).toUTCString().replace(' GMT', ' UTC');
  const since = input.previous?.runAt ? new Date(input.previous.runAt).toUTCString().replace(' GMT', ' UTC') : null;

  const subject = firing.length
    ? `[DQL alert] ${input.pageTitle}: ${firing[0]!.message}${firing.length > 1 ? ` (+${firing.length - 1} more)` : ''}`
    : `[DQL] ${input.pageTitle} · ${new Date(input.runAt).toISOString().slice(0, 10)}`;

  // Markdown: Slack, webhooks, the run log and the email text part.
  const ran = `${dataTiles.length - failed.length} of ${dataTiles.length} tiles ran`;
  const md: string[] = [`# ${input.pageTitle}`, `${input.appTitle} · ${when} · ${ran}${trust.text ? ` · ${trust.text}` : ''}`, ''];
  if (firing.length) {
    md.push('## Alerts');
    for (const evaluation of firing) {
      const started = firingSince[evaluation.monitor.id];
      md.push(`- **${evaluation.message}**${started && started !== input.runAt ? ` Firing since ${new Date(started).toUTCString().replace(' GMT', ' UTC')}.` : ''}`);
      const why = driverExplanation(evaluation, input.items, input.tiles);
      if (why) md.push(`  ${why}`);
    }
    md.push('');
  }
  if (headline.length) {
    md.push('## Headline figures');
    for (const figure of headline) md.push(`- ${figure.label}: **${figure.display}**${figure.changePercent !== undefined ? ` ${changeText(figure)}` : ''}`);
    md.push('');
  }
  if (changes.length) {
    md.push(`## What changed since ${since ?? 'the last run'}`);
    for (const figure of changes) md.push(`- ${figure.label}: ${figure.display} ${changeText(figure)}`);
    md.push('');
  }
  if (drivers.length) {
    md.push('## Drivers on this page');
    for (const driver of drivers) md.push(`- ${driver.title}: ${driver.summary}`);
    md.push('');
  }
  if (failed.length) {
    md.push('## Did not run');
    for (const tile of failed) md.push(`- ${tile.title ?? tile.tileId}: ${tile.error ?? tile.status}`);
    md.push('');
  }
  const quiet = evaluations.filter((evaluation) => evaluation.status !== 'breached');
  if (quiet.length) {
    md.push('## Monitors');
    for (const evaluation of quiet) md.push(`- ${evaluation.message}`);
    md.push('');
  }
  md.push('Every figure comes from the governed page run; nothing here was written by AI.');

  // HTML: an email body with inline styles only (mail clients drop <style>).
  const ink = '#1a1a1a';
  const muted = '#4a4a52';
  const line = '#e9e6e0';
  const up = '#3659c9';
  const down = '#b35a1f';
  const changeHtml = (figure: DigestFigure) => figure.changePercent === undefined
    ? ''
    : `<span style="color:${figure.changePercent > 0 ? up : figure.changePercent < 0 ? down : muted};font-size:13px;white-space:nowrap">${esc(changeText(figure))}</span>`;
  const section = (title: string, body: string) => `<h2 style="margin:24px 0 8px;font-size:15px;font-weight:600;color:${ink}">${esc(title)}</h2>${body}`;
  const list = (rows: string[]) => `<ul style="margin:0;padding-left:18px;color:${ink};font-size:14px;line-height:1.55">${rows.map((row) => `<li style="margin:2px 0">${row}</li>`).join('')}</ul>`;
  const html = [
    `<div style="max-width:640px;margin:0 auto;padding:24px;background:#ffffff;color:${ink};font-family:Inter,-apple-system,'Segoe UI',Arial,sans-serif;font-variant-numeric:tabular-nums">`,
    `<p style="margin:0;color:${muted};font-size:12px;letter-spacing:.04em;text-transform:uppercase">${esc(input.appTitle)}</p>`,
    `<h1 style="margin:4px 0 4px;font-size:22px;font-weight:600">${esc(input.pageTitle)}</h1>`,
    `<p style="margin:0;color:${muted};font-size:13px">${esc(when)} · ${esc(ran)}${trust.text ? ` · <span style="color:#0b7a75;font-weight:600">${esc(trust.text)}</span>` : ''}</p>`,
    firing.length ? `<div style="margin-top:16px;padding:12px 14px;border:1px solid #e3b98a;border-left:4px solid #b35a1f;border-radius:8px;background:#fdf6ee">${firing.map((evaluation) => {
      const started = firingSince[evaluation.monitor.id];
      const why = driverExplanation(evaluation, input.items, input.tiles);
      return `<p style="margin:0 0 4px;font-size:14px;font-weight:600">${esc(evaluation.message)}</p>${started && started !== input.runAt ? `<p style="margin:0 0 4px;color:${muted};font-size:12px">Firing since ${esc(new Date(started).toUTCString().replace(' GMT', ' UTC'))}</p>` : ''}${why ? `<p style="margin:0 0 6px;font-size:13px">${esc(why)}</p>` : ''}`;
    }).join('')}</div>` : '',
    headline.length ? `<table role="presentation" style="width:100%;margin-top:16px;border-collapse:separate;border-spacing:0 8px">${headline.map((figure) => `<tr><td style="padding:10px 12px;border:1px solid ${line};border-right:0;border-radius:8px 0 0 8px;color:${muted};font-size:13px">${esc(figure.label)}</td><td style="padding:10px 12px;border:1px solid ${line};border-left:0;border-radius:0 8px 8px 0;text-align:right"><span style="font-size:20px;font-weight:600">${esc(figure.display)}</span><br>${changeHtml(figure)}</td></tr>`).join('')}</table>` : '',
    changes.length ? section(`What changed since ${since ?? 'the last run'}`, list(changes.map((figure) => `${esc(figure.label)}: <strong>${esc(figure.display)}</strong> ${changeHtml(figure)}`))) : '',
    drivers.length ? section('Drivers on this page', list(drivers.map((driver) => `<strong>${esc(driver.title)}</strong>: ${esc(driver.summary)}`))) : '',
    failed.length ? section('Did not run', list(failed.map((tile) => `${esc(tile.title ?? tile.tileId)}: ${esc(tile.error ?? tile.status)}`))) : '',
    quiet.length ? section('Monitors', list(quiet.map((evaluation) => esc(evaluation.message)))) : '',
    `<p style="margin:24px 0 0;padding-top:12px;border-top:1px solid ${line};color:${muted};font-size:12px">Every figure comes from the governed page run; nothing here was written by AI.</p>`,
    '</div>',
  ].join('');

  const values: DigestState['values'] = {};
  for (const [key, binding] of Object.entries(input.catalog)) values[key] = { value: binding.value, display: binding.display, label: binding.label };
  return {
    subject,
    markdown: md.join('\n'),
    html,
    evaluations,
    firing,
    headline,
    changes,
    trust,
    nextState: { runAt: input.runAt, values, firingSince },
  };
}
