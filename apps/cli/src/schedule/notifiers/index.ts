import type { NotificationIR } from '@duckcodeailabs/dql-compiler';
import type { Notifier, NotifierPayload } from '../types.js';
import { createEmailNotifier } from './email.js';
import { createFileNotifier } from './file.js';
import { createSlackNotifier } from './slack.js';
import { createWebhookNotifier } from './webhook.js';
import { currentHostHooks } from '../../host/request-context.js';

/** A delivery target: compiled block notifications, or an App schedule's webhook. */
export type DeliveryTarget = NotificationIR | { type: 'webhook'; recipients: string[] };

export interface NotificationDispatchResult {
  type: string;
  recipients: string[];
  delivered: boolean;
  error?: string;
}

/**
 * A host's delivery (RFC 0010 HH-8): its own mail, Slack app or signed
 * webhooks in place of DQL's senders. Each target is handed over as it is;
 * the host reports whether it went out.
 */
export type DeliverySink = (message: { type: string; recipients: string[]; payload: NotifierPayload }) => Promise<{ delivered: boolean; error?: string }>;

let deliverySink: DeliverySink | null = null;
/** Install the process's delivery sink, or remove it with null. */
export function setDeliverySink(sink: DeliverySink | null): void {
  deliverySink = sink;
}

export async function dispatchNotifications(
  notifications: DeliveryTarget[],
  payload: NotifierPayload,
  projectRoot: string,
): Promise<NotificationDispatchResult[]> {
  // The current request's server's sink first: a host's previews and Production share a process.
  const scopedHooks = currentHostHooks();
  const activeSink = scopedHooks ? (scopedHooks.delivery ?? null) : deliverySink;
  if (activeSink) {
    const sink = activeSink;
    const delivered: NotificationDispatchResult[] = [];
    for (const n of notifications) {
      try {
        const result = await sink({ type: n.type, recipients: n.recipients, payload });
        delivered.push({ type: n.type, recipients: n.recipients, delivered: result.delivered === true, ...(result.error ? { error: result.error } : {}) });
      } catch (error) {
        delivered.push({ type: n.type, recipients: n.recipients, delivered: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return delivered;
  }
  const notifiers: Record<string, Notifier> = {
    email: createEmailNotifier(),
    slack: createSlackNotifier(),
    file: createFileNotifier(projectRoot),
    webhook: createWebhookNotifier(),
  };

  const out: NotificationDispatchResult[] = [];
  for (const n of notifications) {
    const notifier = notifiers[n.type];
    if (!notifier) {
      out.push({
        type: n.type,
        recipients: n.recipients,
        delivered: false,
        error: `no notifier registered for type "${n.type}"`,
      });
      continue;
    }
    const result = await notifier.send(n.recipients, payload);
    out.push({ type: n.type, recipients: n.recipients, ...result });
  }

  // Always append to file log for audit trail, even if no explicit file target.
  const fileLog = notifiers.file;
  const auditResult = await fileLog.send([], payload);
  if (auditResult.delivered || auditResult.error) {
    out.push({ type: 'file', recipients: ['.dql/runs/notifications.log'], ...auditResult });
  }

  return out;
}
