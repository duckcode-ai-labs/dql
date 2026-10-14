/**
 * SLACK IS A THIN TRANSPORT TO THE RUNTIME, WITH A SCOPE. A question may name
 * its domain up front (`in growth: how many leads`, or `--domain growth how
 * many leads`), a channel may default to one (`ZLENS_SLACK_DOMAIN_DEFAULTS`, a
 * JSON map of channel id to domain), and the runtime resolves the envelope —
 * the bot never does. The conversation is the channel: follow-ups in one
 * channel reach the same thread the notebook would.
 */

export interface SlackAskScope {
  question: string;
  domain?: string;
  purpose?: string;
}

const LEADING_IN = /^in\s+([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:\s*([\s\S]+)$/i;
const FLAG = /(?:^|\s)--(domain|purpose)(?:=|\s+)([A-Za-z0-9_][A-Za-z0-9_.-]*)/gi;

export function parseSlackAskScope(text: string, options: { channelId?: string; defaults?: Record<string, string> } = {}): SlackAskScope {
  let question = text.trim();
  let domain: string | undefined;
  let purpose: string | undefined;
  const leading = LEADING_IN.exec(question);
  if (leading) { domain = leading[1]; question = leading[2].trim(); }
  question = question.replace(FLAG, (_match, flag: string, value: string) => {
    if (flag.toLowerCase() === 'domain') domain = value; else purpose = value;
    return ' ';
  }).replace(/\s+/g, ' ').trim();
  if (!domain && options.channelId && options.defaults?.[options.channelId]) domain = options.defaults[options.channelId];
  return { question, ...(domain ? { domain } : {}), ...(purpose ? { purpose } : {}) };
}

/** The channel defaults, from a JSON map in the environment; malformed input is no default at all. */
export function slackDomainDefaults(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([, value]) => typeof value === 'string' && value.trim()).map(([key, value]) => [key, (value as string).trim()]));
  } catch {
    return {};
  }
}

/** One conversation per Slack channel. */
export function slackThreadId(channelId: string | undefined): string | undefined {
  return channelId ? `slack:${channelId}` : undefined;
}
