/**
 * A QUESTION THAT NAMES A BLOCK.
 *
 * "Using the certified block Eligible Top Players With Player ID, who …" names
 * an object of the project, not values the data holds. The words of that name
 * are never filters an answer must apply ("Eligible", "Players"), and the
 * named block is the answer the person asked for: it runs when it can, or the
 * run says exactly why it cannot.
 *
 * A block counts as named only when the question says so: "block <name>" or
 * "<name> block". A bare phrase that happens to equal a block's name is an
 * ordinary question (review drafts are titled after the questions that made
 * them), and every value in it is still checked.
 */

const words = (value: string): string[] => value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The name as a pattern that tolerates any spacing, punctuation and case between its words. */
function namePattern(name: string): string | undefined {
  const parts = words(name);
  if (parts.length === 0) return undefined;
  return parts.map(escape).join('[^a-z0-9]+');
}

const OPEN_QUOTE = `["'“‘\`]?`;
const CLOSE_QUOTE = `["'”’\`]?`;

function namedRegex(pattern: string): RegExp {
  return new RegExp(
    `\\bblocks?\\s+(?:called\\s+|named\\s+)?${OPEN_QUOTE}(${pattern})${CLOSE_QUOTE}(?![a-z0-9])|(?<![a-z0-9])${OPEN_QUOTE}(${pattern})${CLOSE_QUOTE}\\s+blocks?\\b`,
    'i',
  );
}

/** The names, from `names`, that the question explicitly names as a block. Longest first, so a name never hides inside a longer one. */
export function blocksNamedByQuestion(question: string, names: Iterable<string>): string[] {
  const text = question.toLowerCase();
  if (!/\bblocks?\b/.test(text)) return [];
  const found: string[] = [];
  const sorted = [...new Set(names)].filter((name) => name.trim()).sort((left, right) => words(right).length - words(left).length);
  for (const name of sorted) {
    const pattern = namePattern(name);
    if (!pattern) continue;
    if (namedRegex(pattern).test(text)) found.push(name);
  }
  return found;
}

/** The text with every occurrence of the given block names blanked out, so their words are never read as stated values. */
export function withoutBlockNames(text: string, names: Iterable<string>): string {
  let out = text;
  for (const name of [...new Set(names)].sort((left, right) => right.length - left.length)) {
    const pattern = namePattern(name);
    if (!pattern) continue;
    out = out.replace(new RegExp(`${OPEN_QUOTE}(?<![A-Za-z0-9])${pattern}(?![A-Za-z0-9])${CLOSE_QUOTE}`, 'gi'), ' ');
  }
  return out;
}
