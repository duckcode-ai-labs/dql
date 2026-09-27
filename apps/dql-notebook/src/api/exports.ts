import { authorizedFetch } from './server-auth';

/**
 * Files made on the server (RFC 0010 HH-17). With a host, a download is not
 * the table on screen: DQL runs the statement again for the export, so the
 * host's rules for what may leave (masked or refused columns) apply to
 * exactly what the file holds.
 */
export type ExportFormat = 'csv' | 'json' | 'xlsx';

export const EXPORT_LABELS: Record<ExportFormat, string> = { csv: 'CSV', json: 'JSON', xlsx: 'Excel' };

/** POST to an export route and save the file it answers with; returns its name, or throws with the server's reason. */
export async function downloadServerExport(url: string, body: unknown): Promise<string> {
  const response = await authorizedFetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: unknown };
    throw new Error(typeof payload.error === 'string' && payload.error ? payload.error : `The export did not run (${response.status}).`);
  }
  const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'export';
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
  return name;
}

/** One tile of a published App page, run again for the file. */
export function exportAppTile(appId: string, dashboardId: string, input: { tileId: string; format: ExportFormat; variables?: Record<string, unknown> }): Promise<string> {
  return downloadServerExport(`/api/apps/${encodeURIComponent(appId)}/dashboards/${encodeURIComponent(dashboardId)}/export`, input);
}

/** A SQL statement's result, run again for the file. */
export function exportQuery(input: { sql: string; format: ExportFormat; title?: string; executionTarget?: unknown }): Promise<string> {
  return downloadServerExport('/api/query/export', input);
}
