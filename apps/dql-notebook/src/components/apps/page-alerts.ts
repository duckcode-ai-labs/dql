import { figureLabel, type StoryBindingCatalog } from '@zlens/core/apps/story-bindings';
import type { AppMonitorConditionV1, AppScheduleDeliveryV1 } from '../../api/client';

/**
 * Wording for page alerts (RFC 0008 step 10). Pure: no React, no I/O.
 */

export type AlertRule = 'below' | 'above' | 'falls' | 'rises' | 'changes';

export const ALERT_RULES: Array<{ rule: AlertRule; label: string; unit: 'value' | 'percent' }> = [
  { rule: 'below', label: 'falls below', unit: 'value' },
  { rule: 'above', label: 'rises above', unit: 'value' },
  { rule: 'falls', label: 'falls by', unit: 'percent' },
  { rule: 'rises', label: 'rises by', unit: 'percent' },
  { rule: 'changes', label: 'changes by', unit: 'percent' },
];

export function alertCondition(rule: AlertRule, amount: number): AppMonitorConditionV1 {
  if (rule === 'below') return { kind: 'threshold', op: '<', value: amount };
  if (rule === 'above') return { kind: 'threshold', op: '>', value: amount };
  return { kind: 'change', direction: rule === 'falls' ? 'down' : rule === 'rises' ? 'up' : 'either', percent: amount };
}

const plain = (value: number) => (Math.abs(value) >= 1000 ? value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(value));

/** "falls below $100", "falls by 20% since the last run". */
export function describeCondition(when: AppMonitorConditionV1, display?: string): string {
  if (when.kind === 'threshold') {
    const word = when.op === '<' ? 'falls below' : when.op === '<=' ? 'is at or below' : when.op === '>' ? 'rises above' : 'is at or above';
    const unitless = plain(when.value);
    const amount = display?.trim().startsWith('$') ? `$${unitless}` : display?.trim().endsWith('%') ? `${unitless}%` : unitless;
    return `${word} ${amount}`;
  }
  const word = when.direction === 'down' ? 'falls' : when.direction === 'up' ? 'rises' : 'changes';
  return `${word} by ${when.percent}% since the last run`;
}

const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

/** "Checked daily at 08:00"; unusual schedules show their cron. */
export function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length === 5 && /^\d+$/.test(parts[0]!) && /^\d+$/.test(parts[1]!) && parts[2] === '*' && parts[3] === '*') {
    const time = `${parts[1]!.padStart(2, '0')}:${parts[0]!.padStart(2, '0')}`;
    if (parts[4] === '*') return `daily at ${time}`;
    if (/^[0-6]$/.test(parts[4]!)) return `${DAYS[Number(parts[4])]} at ${time}`;
    if (parts[4] === '1-5') return `weekdays at ${time}`;
  }
  if (parts.length === 5 && parts[0] === '0' && parts.slice(1).every((part) => part === '*')) return 'every hour';
  return `on cron ${cron}`;
}

export function describeDelivery(deliver: AppScheduleDeliveryV1[]): string {
  if (!deliver.length) return 'recorded in the run log only';
  return deliver.map((target) => (
    target.kind === 'slack' ? `Slack ${target.channel}`
      : target.kind === 'email' ? `email to ${target.to.join(', ')}`
        : `webhook ${safeHost(target.url)}`
  )).join(', ');
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The figures an alert can watch: numbers the run returned, single values
 * first, then members of grouped tiles. Driver and leader keys are derived
 * from other figures and are left out.
 */
export function alertFigures(catalog: StoryBindingCatalog): Array<{ key: string; label: string; display: string }> {
  const derived = /\.(leader|leader_value|current|prior|change|change_percent|top_dimension|top_member|top_member_change)$/;
  return Object.values(catalog)
    .filter((binding) => binding.kind === 'number' && typeof binding.value === 'number' && !derived.test(binding.key))
    .sort((left, right) => Number(left.key.includes('[')) - Number(right.key.includes('[')) || left.label.localeCompare(right.label))
    .map((binding) => ({ key: binding.key, label: figureLabel(binding.label), display: binding.display }));
}
