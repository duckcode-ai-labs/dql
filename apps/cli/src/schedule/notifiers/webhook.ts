import type { Notifier, NotifierPayload } from '../types.js';

/**
 * Posts a scheduled run to each webhook URL as JSON: the digest markdown plus
 * one record per tile. Only http(s) URLs are accepted, and a non-2xx answer is
 * reported as undelivered rather than retried silently.
 */
export function createWebhookNotifier(fetchImpl: typeof fetch = fetch): Notifier {
  return {
    type: 'webhook',
    async send(recipients, payload) {
      if (recipients.length === 0) return { delivered: false, error: 'no webhook URL configured' };
      const failures: string[] = [];
      for (const url of recipients) {
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          failures.push(`${url}: not a valid URL`);
          continue;
        }
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          failures.push(`${parsed.origin}: only http and https webhooks are supported`);
          continue;
        }
        try {
          const response = await fetchImpl(parsed.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(webhookBody(payload)),
          });
          if (!response.ok) failures.push(`${parsed.origin}: HTTP ${response.status}`);
        } catch (error) {
          failures.push(`${parsed.origin}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return failures.length ? { delivered: false, error: failures.join('; ') } : { delivered: true };
    },
  };
}

function webhookBody(payload: NotifierPayload) {
  return {
    source: 'dql',
    kind: 'app_schedule',
    title: payload.digestTitle ?? payload.block,
    run: payload.block,
    path: payload.path,
    trigger: payload.trigger,
    startedAt: payload.startedAt,
    ...(payload.subject ? { subject: payload.subject } : {}),
    ...(payload.appPage ? { appPage: payload.appPage } : {}),
    markdown: payload.markdown ?? '',
    ...(payload.html ? { html: payload.html } : {}),
    ...(payload.monitors ? {
      monitors: payload.monitors.map((evaluation) => ({
        id: evaluation.monitor.id,
        binding: evaluation.monitor.binding,
        status: evaluation.status,
        firing: evaluation.status === 'breached',
        message: evaluation.message,
        ...(evaluation.current ? { current: evaluation.current } : {}),
        ...(evaluation.previous ? { previous: evaluation.previous } : {}),
      })),
    } : {}),
    tiles: payload.queries.map((query) => ({
      tileId: query.chartId,
      rowCount: query.rowCount,
      ...(query.error ? { error: query.error } : { preview: query.preview ?? [] }),
    })),
  };
}
