import type { Notifier, NotifierPayload } from '../types.js';
import { readEnv } from '@zlens/core';

export function createSlackNotifier(): Notifier {
  return {
    type: 'slack',
    async send(recipients, payload) {
      const webhook = readEnv('ZLENS_SLACK_WEBHOOK');
      if (!webhook) {
        return {
          delivered: false,
          error: 'ZLENS_SLACK_WEBHOOK environment variable is not set',
        };
      }

      const breached = payload.alerts.filter((a) => a.breached);
      const hasDigest = Boolean(payload.markdown);

      // Skip noise: no digest to deliver AND no alert breached.
      if (!hasDigest && breached.length === 0) {
        return { delivered: true };
      }

      const channels = recipients.length > 0 ? recipients : ['#default'];
      const text = hasDigest
        ? [
            `*${payload.subject ?? `[DQL Digest] ${payload.digestTitle ?? payload.block}`}*`,
            `Generated: ${payload.startedAt} (${payload.trigger})`,
            '',
            truncateMarkdown(payload.markdown as string, 2500),
          ].join('\n')
        : [
            `*[DQL] ${payload.block}* — ${breached.length} alert(s) breached`,
            `Triggered: ${payload.trigger} at ${payload.startedAt}`,
            ...breached.map(
              (a) =>
                `• \`${a.alert.conditionSQL}\` ${a.alert.operator ?? '>'} ${a.alert.threshold ?? 0} — observed \`${a.observedValue}\`${a.alert.message ? ` — ${a.alert.message}` : ''}`,
            ),
          ].join('\n');

      try {
        for (const channel of channels) {
          const res = await fetch(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel, text }),
          });
          if (!res.ok) {
            return {
              delivered: false,
              error: `slack webhook returned ${res.status} ${res.statusText}`,
            };
          }
        }
        return { delivered: true };
      } catch (err) {
        return { delivered: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

function truncateMarkdown(md: string, limit: number): string {
  if (md.length <= limit) return md;
  return md.slice(0, limit).trimEnd() + '\n…';
}
