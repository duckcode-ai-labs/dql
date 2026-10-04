import type { AnalyticalIntentV1, IntentPredicate } from './intent.js';

/**
 * A FOLLOW-UP'S EARLIER VALUES, FOR A MODEL OUTSIDE THE PRIVACY BOUNDARY.
 * A follow-up's earlier reading carries the values its restrictions name (a
 * member as the person typed it, or as the warehouse stores it) and its
 * AI-drafted SQL carries them as literals. When values may not reach the model
 * (RFC 0010 HH-5), each such value is named by position (`[value 1]`) in what
 * the model reads, and the model's answer has the real values put back before
 * DQL uses it. The model still sees which restrictions exist and where, so a
 * follow-up keeps them; it never sees what they hold.
 */
export interface PriorValueMask {
  /** The earlier reading as the model is shown it. */
  prior: AnalyticalIntentV1;
  /** A text the model will read, with every earlier value named by position. */
  maskText(text: string): string;
  /** A text the model wrote (a reading, a statement), with the real values put back. */
  restoreText(text: string): string;
  /** A reading the model wrote, with the real values put back in its restrictions and its wording. */
  restoreIntent(intent: AnalyticalIntentV1): AnalyticalIntentV1;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The text values of a reading's restrictions (filters and measure scopes). */
function predicateValues(intent: AnalyticalIntentV1): string[] {
  const predicates: IntentPredicate[] = [...intent.filters, ...intent.measures.flatMap((measure) => measure.scope ?? [])];
  return predicates.flatMap((predicate) => predicate.values.filter((value): value is string => typeof value === 'string'));
}

/** The string literals of a statement (`'it''s'` read as `it's`). */
export function sqlStringValues(sql: string): string[] {
  return [...sql.matchAll(/'((?:[^']|'')*)'/g)].map((match) => match[1]!.replace(/''/g, "'"));
}

/**
 * A mask over the earlier reading's values (and any other earlier values, such as the literals of its SQL). Values
 * that are only a date or a number are left as they are: they say when and how much, not who or what.
 */
export function priorWithoutValues(prior: AnalyticalIntentV1, otherValues: string[] = []): PriorValueMask {
  const tokens = new Map<string, string>();
  for (const value of [...predicateValues(prior), ...otherValues]) {
    const trimmed = value.trim();
    if (!trimmed || tokens.has(value)) continue;
    if (/^[\d\s.,:/+-]*$/.test(trimmed) || /^\d{4}-\d{2}-\d{2}(?:[ T][\d:.]+Z?)?$/.test(trimmed)) continue;
    tokens.set(value, `[value ${tokens.size + 1}]`);
  }
  const back = new Map([...tokens].map(([value, token]) => [token, value]));
  // Longest first, so a value inside another is not cut out of it.
  const ordered = [...tokens.entries()].sort((left, right) => right[0].length - left[0].length);
  const maskText = (text: string): string => {
    let masked = text;
    for (const [value, token] of ordered) {
      masked = masked.split(`'${value.replace(/'/g, "''")}'`).join(`'${token}'`);
      if (/[\p{L}\p{N}]/u.test(value) && value.trim().length >= 2) {
        masked = masked.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(value)}(?![\\p{L}\\p{N}_])`, 'giu'), token);
      }
    }
    return masked;
  };
  const restoreText = (text: string): string => {
    let restored = text;
    for (const [token, value] of back) {
      restored = restored.split(`'${token}'`).join(`'${value.replace(/'/g, "''")}'`).split(token).join(value);
    }
    return restored;
  };
  const maskPredicate = (predicate: IntentPredicate): IntentPredicate => ({ ...predicate, values: predicate.values.map((value) => (typeof value === 'string' && tokens.has(value) ? tokens.get(value)! : value)) });
  const restorePredicate = (predicate: IntentPredicate): IntentPredicate => ({ ...predicate, values: predicate.values.map((value) => (typeof value === 'string' ? (back.get(value) ?? restoreText(value)) : value)) });
  const shown: AnalyticalIntentV1 = {
    ...prior,
    reading: maskText(prior.reading ?? ''),
    filters: prior.filters.map(maskPredicate),
    measures: prior.measures.map((measure) => (measure.scope ? { ...measure, scope: measure.scope.map(maskPredicate) } : measure)),
  };
  return {
    prior: shown,
    maskText,
    restoreText,
    restoreIntent: (intent) => ({
      ...intent,
      reading: restoreText(intent.reading ?? ''),
      filters: intent.filters.map(restorePredicate),
      measures: intent.measures.map((measure) => (measure.scope ? { ...measure, scope: measure.scope.map(restorePredicate) } : measure)),
    }),
  };
}
