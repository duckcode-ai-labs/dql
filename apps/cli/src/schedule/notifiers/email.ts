import type { Notifier, NotifierPayload } from '../types.js';
import { readEnv } from '@zlens/core';

export function createEmailNotifier(): Notifier {
  return {
    type: 'email',
    async send(recipients, payload) {
      if (recipients.length === 0) {
        return { delivered: false, error: 'no email recipients provided' };
      }
      const smtpUrl = readEnv('ZLENS_SMTP_URL');
      const from = readEnv('ZLENS_SMTP_FROM') ?? 'dql@localhost';

      const subject = buildSubject(payload);
      // Digest runs deliver the rendered HTML + markdown sibling as the email
      // body; non-digest runs fall back to the legacy alert/query summary.
      const textBody = payload.markdown ?? buildBody(payload);
      const htmlBody = payload.html;

      if (!smtpUrl) {
        console.log(`[zlens schedule] email stub — no ZLENS_SMTP_URL set`);
        console.log(`  to: ${recipients.join(', ')}`);
        console.log(`  subject: ${subject}`);
        if (htmlBody) console.log(`  html: ${htmlBody.length} chars`);
        console.log(textBody);
        return { delivered: false, error: 'ZLENS_SMTP_URL not set (stub mode)' };
      }

      try {
        // Dynamic import so nodemailer only loads when SMTP is actually configured.
        const nodemailer = (await import('nodemailer' as string)) as typeof import('nodemailer');
        const transporter = nodemailer.createTransport(smtpUrl);
        await transporter.sendMail({
          from,
          to: recipients.join(', '),
          subject,
          text: textBody,
          ...(htmlBody ? { html: htmlBody } : {}),
        });
        return { delivered: true };
      } catch (err) {
        return { delivered: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

function buildSubject(payload: NotifierPayload): string {
  if (payload.subject) return payload.subject;
  const breached = payload.alerts.filter((a) => a.breached).length;
  if (payload.markdown) {
    return `[DQL Digest] ${payload.digestTitle ?? payload.block}`;
  }
  const prefix = breached > 0 ? `[DQL ALERT]` : `[DQL]`;
  return `${prefix} ${payload.block} — ${payload.trigger} run`;
}

function buildBody(payload: NotifierPayload): string {
  const lines: string[] = [
    `Block: ${payload.block}`,
    `Path: ${payload.path}`,
    `Started: ${payload.startedAt}`,
    `Trigger: ${payload.trigger}`,
    '',
  ];

  if (payload.alerts.length > 0) {
    lines.push('Alerts:');
    for (const a of payload.alerts) {
      lines.push(
        `  ${a.breached ? '!' : '-'} ${a.alert.conditionSQL} ${a.alert.operator ?? '>'} ${a.alert.threshold ?? 0}` +
          (a.observedValue !== undefined ? ` (observed ${a.observedValue})` : '') +
          (a.error ? ` [error: ${a.error}]` : ''),
      );
      if (a.alert.message) lines.push(`    message: ${a.alert.message}`);
    }
    lines.push('');
  }

  lines.push('Queries:');
  for (const q of payload.queries) {
    lines.push(`  ${q.chartId}: ${q.rowCount} rows in ${q.durationMs}ms${q.error ? ` [error: ${q.error}]` : ''}`);
  }

  return lines.join('\n');
}
