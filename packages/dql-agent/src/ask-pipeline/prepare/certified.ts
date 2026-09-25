import type { AnalyticalIntentV1 } from '../intent.js';
import type { VocabularyEntry, VocabularyIndex } from '../vocabulary.js';
import type { PrepareDeps, PreparedCandidate, PreparedRefusal } from './types.js';

/**
 * CERTIFIED = ENTAILMENT, NOT LEXICAL FIT.
 *
 * A block is a certified answer only when its contract entails the intent:
 * the intent names the block (or measures whose physical binding is one of
 * the block's aggregates over the same scope), every grouping and display
 * ref is an output the block produces, every filter is one the block
 * declares it accepts, and the ordering and limit are provable from the
 * block's own ORDER BY and LIMIT. An intent with no measures never entails.
 * Anything less makes the block evidence for the governed tiers, not an
 * answer.
 */

export interface EntailmentVerdict {
  ok: boolean;
  missing: string[];
  caveats: string[];
  /** Set when the only identity the block offers is a label; the block is a fallback, not the answer. */
  identityNote?: string;
  /** The output column a time window is applied over, when the block has one. */
  windowColumn?: string;
}

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');
const leaf = (ref: string) => (ref.split('.').pop() ?? ref).toLowerCase();

export function entails(block: VocabularyEntry, intent: AnalyticalIntentV1, vocabulary: VocabularyIndex): EntailmentVerdict {
  const contract = block.contract;
  const missing: string[] = [];
  const caveats: string[] = [];
  if (!contract) return { ok: false, missing: ['the block has no contract'], caveats };
  if (intent.measures.length === 0) return { ok: false, missing: ['the intent names no measure'], caveats };
  // A ratio the question composes, or a population the block never declared, is never what a block certified.
  if (intent.measures.some((measure) => measure.derived)) return { ok: false, missing: ['a derived ratio measure is composed by the governed tiers, never served from a block'], caveats };
  if (intent.population === 'all') return { ok: false, missing: ['a block returns the rows it matched; it cannot include every member of the entity'], caveats };
  const outputs = new Set(contract.outputs.map(norm));

  const namesBlock = intent.measures.every((measure) => measure.ref === block.ref);
  if (!namesBlock) {
    // Measures by physical binding: same aggregate over the same source column.
    for (const measure of intent.measures) {
      const entry = vocabulary.get(measure.ref);
      const physical = entry?.physical;
      const match = contract.measures.find((candidate) =>
        physical && candidate.aggregate && physical.aggregate === candidate.aggregate
        && ((candidate.sourceColumn && physical.column && norm(candidate.sourceColumn) === norm(physical.column))
          || (candidate.expr && physical.expr && norm(candidate.expr) === norm(physical.expr))));
      if (!match) missing.push(`${measure.ref} is not one of the block's measures (${contract.measures.map((m) => m.output).join(', ') || 'none'})`);
      if (measure.scope?.length) {
        for (const predicate of measure.scope) {
          const column = leaf(predicate.ref);
          const covered = contract.staticScope.some((scope) => norm(scope.column) === norm(column) && scopeMatches(scope.op, scope.values, predicate.op, predicate.values));
          if (!covered) missing.push(`the block does not restrict ${column} the way the measure requires`);
        }
      }
    }
  } else if (intent.measures.length > 1) {
    missing.push('a certified answer names one block');
  }

  // IDENTITY: a ranking or breakdown of an entity must be keyed. A block whose
  // grouping columns are all labels cannot prove which customer is which, so it
  // is evidence, not a certified answer, until it is recertified with the key.
  const grouping = contract.groupBy.length ? contract.groupBy : contract.outputs.filter((output) => !contract.measures.some((m) => norm(m.output) === norm(output)));
  const keyLike = (column: string) => /(^|_)(id|key|uuid|code|number)$/i.test(column);
  const labelLike = (column: string) => /(^|_)(name|label|title)(_|$)/i.test(column);
  let identityNote: string | undefined;
  if (grouping.length > 0 && grouping.every(labelLike) && !grouping.some(keyLike)) {
    const note = `the block groups by ${grouping.join(', ')} (a label) with no identity key, so two entities sharing a name would merge`;
    // Identity is never certified away: even a block the intent names is
    // evidence, not the answer, until it is recertified with the key. The
    // refusal is repairable, so the interpreter re-expresses the analysis
    // with the block's measures by entity and the keyed governed query answers.
    identityNote = `${note}; the answer is composed by entity key instead, and the block can be recertified with the key column`;
    missing.push(identityNote);
  }
  // A time window is applied over the block's output when an output column IS
  // the window's time column; a block with no such column cannot bound the
  // period, and a published SQL never has a window silently assumed.
  let windowColumn: string | undefined;
  if (intent.time?.window) {
    const axis = intent.time.ref ? vocabulary.get(intent.time.ref) : undefined;
    const wanted = [axis?.physical?.column, axis?.name, intent.time.ref ? leaf(intent.time.ref) : undefined].filter((name): name is string => Boolean(name)).map(norm);
    windowColumn = contract.outputs.find((output) => wanted.includes(norm(output)));
    if (!windowColumn) missing.push(`the block has no output for the time window ${intent.time.window.start}..${intent.time.window.end} (${wanted.join('/')}), so it cannot bound the period; the answer is composed from its measures instead`);
  }
  // Every grouping and display column must be an output.
  for (const group of intent.groupBy) {
    const entry = vocabulary.get(group.ref);
    const column = entry?.physical?.column ?? entry?.name ?? leaf(group.ref);
    if (!outputs.has(norm(column))) missing.push(`grouping by ${column} is not an output of the block (${contract.outputs.join(', ')})`);
    if (group.role === 'time' && group.grain) caveats.push(`time grain ${group.grain} is assumed to match the block's own grouping`);
  }
  for (const ref of intent.display) {
    const entry = vocabulary.get(ref);
    const column = entry?.physical?.column ?? entry?.name ?? leaf(ref);
    if (!outputs.has(norm(column))) missing.push(`display of ${column} is not an output of the block`);
  }

  // The block's own scope must be what the intent asked for, and every intent filter must be accepted.
  const intentPredicates = [...intent.filters, ...intent.measures.flatMap((measure) => measure.scope ?? [])];
  // A block the intent names by ref was chosen FOR its declared scope; a block
  // matched through its measures must have that scope asked for explicitly.
  for (const scope of namesBlock ? [] : contract.staticScope) {
    const asked = intentPredicates.some((predicate) => norm(leaf(predicate.ref)) === norm(scope.column) && scopeMatches(scope.op, scope.values, predicate.op, predicate.values));
    if (!asked) missing.push(`the block is restricted to ${scope.column} ${scope.op}${scope.values.length ? ` ${scope.values.join('/')}` : ''}, which the question did not ask for`);
  }
  const accepted = new Set([...contract.allowedFilters, ...contract.parameters, ...contract.staticScope.map((scope) => scope.column), ...(namesBlock ? contract.outputs : [])].map(norm));
  for (const predicate of namesBlock ? intentPredicates : intent.filters) {
    const column = leaf(predicate.ref);
    const asStatic = contract.staticScope.some((scope) => norm(scope.column) === norm(column) && scopeMatches(scope.op, scope.values, predicate.op, predicate.values));
    if (!asStatic && !accepted.has(norm(column))) missing.push(`the block does not accept a filter on ${column}`);
    if (!asStatic && accepted.has(norm(column))) caveats.push(`filter on ${column} needs the block's parameter binding`);
  }

  // Ordering and limit must be provable.
  if (intent.ordering) {
    const orderColumn = intent.ordering.ref.startsWith('measure:') ? contract.measures[0]?.output : (vocabulary.get(intent.ordering.ref)?.physical?.column ?? leaf(intent.ordering.ref));
    const first = contract.orderBy?.[0];
    const sameColumn = first && orderColumn && (norm(first.column) === norm(orderColumn) || contract.measures.some((m) => norm(m.output) === norm(first.column) && vocabulary.get(intent.ordering!.ref)?.physical?.column && norm(m.sourceColumn ?? '') === norm(vocabulary.get(intent.ordering!.ref)!.physical!.column!)));
    if (!first || !sameColumn || first.direction !== intent.ordering.direction) missing.push('the block does not order the way the question asks');
  }
  if (intent.limit !== undefined) {
    if (contract.limit === undefined) missing.push(`the block has no row limit; the question asks for ${intent.limit}`);
    else if (contract.limit !== intent.limit) missing.push(`the block returns ${contract.limit} rows; the question asks for ${intent.limit}`);
  } else if (contract.limit !== undefined) {
    caveats.push(`the block returns at most ${contract.limit} rows`);
  }
  if (!contract.structural) caveats.push('the block SQL could not be read structurally; only its declarations were checked');
  return { ok: missing.length === 0, missing, caveats, ...(identityNote ? { identityNote } : {}), ...(windowColumn ? { windowColumn } : {}) };
}

function scopeMatches(op: string, values: string[], intentOp: string, intentValues: Array<string | number | boolean>): boolean {
  const boolOf = (v: unknown) => (v === true || String(v).toLowerCase() === 'true') ? 'true' : (v === false || String(v).toLowerCase() === 'false') ? 'false' : undefined;
  if (op === 'is_true' || op === 'is_false') {
    if (intentOp === op) return true;
    if (intentOp === 'eq' && intentValues.length === 1) return boolOf(intentValues[0]) === (op === 'is_true' ? 'true' : 'false');
    return false;
  }
  if ((op === 'eq' || op === 'in') && (intentOp === 'eq' || intentOp === 'in')) {
    const left = new Set(values.map((value) => value.toLowerCase()));
    return intentValues.every((value) => left.has(String(value).toLowerCase())) && intentValues.length === left.size;
  }
  return op === intentOp && values.join('|').toLowerCase() === intentValues.map(String).join('|').toLowerCase();
}

export interface CertifiedPreparation {
  candidates: PreparedCandidate[];
  refusals: PreparedRefusal[];
  /**
   * Blocks refused ONLY for label-only identity. They are not the answer
   * while a keyed governed answer can be composed; when no other tier can
   * prepare, the block is served as published with its identity caveat
   * rather than a dead end.
   */
  fallbacks: PreparedCandidate[];
}

/**
 * Whether the question itself asks for this report: its name or label
 * appears, or it restates one of the block's declared example questions. A
 * block's tags are search aids, not names ("agent" names no report).
 */
export function questionNamesBlock(question: string, block: VocabularyEntry): boolean {
  const text = ` ${question.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  const phrase = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  // Every content word of the report's name, in any simple form ("revenue
  // by month" names Monthly Revenue; "premiums paid by policy holders" does
  // not name Book of Business by Agent and Policy Holder).
  const stem = (word: string) => word.replace(/(ly|ies|es|s)$/, '');
  const NAME_STOPWORDS = new Set(['by', 'and', 'of', 'the', 'for', 'per', 'a', 'an', 'in', 'on', 'to', 'with']);
  const askedStems = new Set(text.trim().split(' ').filter(Boolean).map(stem));
  for (const name of [block.name, block.label ?? ''].map(phrase)) {
    if (name.replace(/ /g, '').length >= 4 && text.includes(` ${name} `)) return true;
    const words = name.split(' ').filter((word) => word && !NAME_STOPWORDS.has(word));
    if (words.length >= 2 && words.every((word) => askedStems.has(stem(word)))) return true;
  }
  const words = (value: string) => new Set(phrase(value).split(' ').filter((word) => word.length > 2));
  const asked = words(question);
  return (block.examples ?? []).some((example) => {
    const wanted = words(example);
    if (wanted.size === 0) return false;
    let shared = 0;
    for (const word of wanted) if (asked.has(word)) shared += 1;
    return shared / wanted.size >= 0.8 && shared / Math.max(1, asked.size) >= 0.6;
  });
}

export function prepareCertified(intent: AnalyticalIntentV1, vocabulary: VocabularyIndex, deps: PrepareDeps, question?: string, prior?: AnalyticalIntentV1): CertifiedPreparation {
  const blocks = vocabulary.entries.filter((entry) => entry.kind === 'block' && entry.certified);
  if (blocks.length === 0) return { candidates: [], refusals: [{ tier: 'certified', code: 'no_certified_block', message: 'the project has no certified block', repairable: false }], fallbacks: [] };
  const candidates: PreparedCandidate[] = [];
  const refusals: PreparedRefusal[] = [];
  const fallbacks: PreparedCandidate[] = [];
  const named = intent.measures.map((measure) => measure.ref).filter((ref) => ref.startsWith('block:'));
  const considered = named.length ? blocks.filter((block) => named.includes(block.ref)) : blocks;
  for (const block of considered) {
    const verdict = entails(block, intent, vocabulary);
    // The block is compiled and bound like every other surface runs it. The
    // raw-text path survives only for blocks without template parameters.
    const prepared = deps.prepareBlock?.(block.ref, { question: intent.reading });
    if (prepared && 'error' in prepared) {
      refusals.push({ tier: 'certified', code: 'block_not_applicable', message: `${block.ref}: its parameters could not be bound: ${prepared.error}`, repairable: false, detail: { unresolved: prepared.unresolved ?? [] } });
      continue;
    }
    const rawSource = prepared ? undefined : (deps.blockSql?.(block.ref) ?? block.sql);
    if (rawSource && /\$\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}/.test(rawSource)) {
      refusals.push({ tier: 'certified', code: 'block_not_applicable', message: `${block.ref}: declares template parameters that this host does not bind`, repairable: false });
      continue;
    }
    const source = prepared?.sql ?? rawSource;
    const identityOnly = !verdict.ok && verdict.identityNote !== undefined && verdict.missing.length === 1;
    if ((verdict.ok || identityOnly) && source) {
      // Filters the block declares it accepts are applied OVER its output, so
      // the certified logic runs unchanged and the filter is provably present.
      const params: unknown[] = prepared ? [...prepared.params] : [];
      // Applied predicates continue the block's positional numbering; a block
      // without parameters keeps the composer's `?` placeholders.
      const placeholder = () => { if (!prepared) return '?'; return `$${params.length}`; };
      const bind = (value: unknown) => { params.push(value); return placeholder(); };
      const outputs = new Set((block.contract?.outputs ?? []).map(norm));
      const applied: string[] = [];
      const blockPredicates = [...intent.filters, ...intent.measures.filter((measure) => measure.ref === block.ref).flatMap((measure) => measure.scope ?? [])];
      for (const predicate of blockPredicates) {
        const column = leaf(predicate.ref);
        const staticMatch = block.contract?.staticScope.some((scope) => norm(scope.column) === norm(column));
        if (staticMatch) continue;
        const output = (block.contract?.outputs ?? []).find((name) => norm(name) === norm(column));
        if (!output || !outputs.has(norm(column))) continue;
        const quoted = `"${output.replace(/"/g, '""')}"`;
        const value = predicate.values[0];
        if (predicate.op === 'eq' && typeof value === 'string') applied.push(`LOWER(CAST(block.${quoted} AS TEXT)) = ${bind(value.toLowerCase())}`);
        else if (predicate.op === 'eq') applied.push(`block.${quoted} = ${bind(value)}`);
        else if (predicate.op === 'in') applied.push(`LOWER(CAST(block.${quoted} AS TEXT)) IN (${predicate.values.map((item) => bind(typeof item === 'string' ? item.toLowerCase() : item)).join(', ')})`);
        else if (predicate.op === 'is_true') applied.push(`block.${quoted} = TRUE`);
        else if (predicate.op === 'is_false') applied.push(`block.${quoted} = FALSE`);
        else applied.push(`block.${quoted} ${({ neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' } as Record<string, string>)[predicate.op] ?? '='} ${bind(value)}`);
      }
      if (intent.time?.window && verdict.windowColumn) {
        const quoted = `"${verdict.windowColumn.replace(/"/g, '""')}"`;
        applied.push(`block.${quoted} >= ${bind(intent.time.window.start)}`, `block.${quoted} < ${bind(intent.time.window.end)}`);
      }
      const sql = applied.length ? `SELECT * FROM (\n${source.trim().replace(/;\s*$/, '')}\n) AS block\nWHERE ${applied.join(' AND ')}` : source;
      const candidate: PreparedCandidate = {
        tier: 'certified', trust: 'certified', sql, ...(params.length ? { params } : {}), sourceRef: block.ref,
        // The DQL the answer ran is the certified block itself, as it is saved.
        ...(prepared && 'source' in prepared && prepared.source ? { artifact: { kind: 'certified_block', name: block.name, source: prepared.source, ...(prepared.sourcePath ? { sourcePath: prepared.sourcePath } : {}), persistence: 'saved', trustState: 'certified', compiledSql: sql } } : {}),
        proof: [`${block.ref} entails the intent: ${block.contract?.measures.map((m) => m.output).join(', ') || 'declared outputs'}${block.contract?.staticScope.length ? ` with scope ${block.contract.staticScope.map((s) => `${s.column} ${s.op}`).join(', ')}` : ''}${applied.length ? `; ${applied.length} declared filter${applied.length > 1 ? 's' : ''} applied over its output` : ''}`, ...(prepared?.parameters.length ? [`parameters bound: ${prepared.parameters.map((parameter) => `${parameter.name} = ${JSON.stringify(parameter.value)} (${parameter.source})`).join(', ')}`] : []), ...verdict.caveats],
      };
      // A REPORT THE AI CHOSE IS NOT A CERTIFIED ANSWER. When the reading
      // names a block the question never asked for, the block matched only
      // because its declarations cover a reading the AI collapsed onto it (a
      // report per policy served for "each premium paid"). It is a near fit:
      // the governed tiers and the drafter (who sees it as the team's
      // computation) answer first, and it is served only as a last resort,
      // for review.
      // A follow-up continues the previous turn: a report that turn used or named is named here too.
      const priorNamed = Boolean(prior && (prior.measures.some((measure) => measure.ref === block.ref) || questionNamesBlock(prior.reading, block)));
      const chosenByReading = question !== undefined && named.includes(block.ref) && !questionNamesBlock(question, block) && !priorNamed;
      if (chosenByReading) {
        candidate.trust = 'review_required';
        candidate.proof.push(`${block.ref} is a near fit the AI chose; the question does not name this certified report, so it is not proof the report answers exactly what was asked`);
        fallbacks.push(candidate);
        refusals.push({ tier: 'certified', code: 'block_not_applicable', message: `${block.ref}: chosen by the reading, not named by the question; a near fit, not a certified answer`, repairable: false });
      } else if (identityOnly) {
        candidate.proof.push(`${verdict.identityNote!.split(';')[0]}; the certified block is served as published because no keyed governed answer could be composed`);
        fallbacks.push(candidate);
        refusals.push({ tier: 'certified', code: 'block_not_applicable', message: `${block.ref}: ${verdict.identityNote}`, repairable: named.includes(block.ref), detail: verdict });
      } else {
        candidates.push(candidate);
      }
    } else if (named.includes(block.ref) || verdict.missing.length <= 2) {
      // A block the model named but which does not entail the intent is a
      // repairable refusal: the resolver can re-express the analysis with the
      // metric and dimension refs the block was standing in for.
      refusals.push({ tier: 'certified', code: 'block_not_applicable', message: `${block.ref}: ${verdict.missing.join('; ') || 'no SQL source'}`, repairable: named.includes(block.ref), detail: verdict });
    }
  }
  if (candidates.length === 0 && refusals.length === 0) {
    refusals.push({ tier: 'certified', code: 'block_not_applicable', message: `no certified block entails the intent (${blocks.map((block) => block.ref).join(', ')})`, repairable: false });
  }
  return { candidates, refusals, fallbacks };
}
