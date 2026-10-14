/**
 * A BUSINESS TERM IS AUTHORED IN THE PRODUCT, not only by `zlens new term`. The
 * template the CLI writes is the one Domain Studio and the context-authoring
 * proposals write, so a term reaches the Ask vocabulary the same way whoever
 * wrote it.
 */
export interface TermTemplateInput {
  title: string;
  domain: string;
  owner: string;
  description?: string;
  type?: 'entity' | 'metric' | 'dimension' | 'event' | 'attribute';
  status?: 'draft' | 'reviewed' | 'certified';
  identifiers?: string[];
  synonyms?: string[];
  businessRules?: string[];
  caveats?: string[];
  metricRefs?: string[];
  tags?: string[];
}

export function termSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'term';
}

const quoteList = (values: string[] | undefined): string => `[${(values ?? []).map((value) => JSON.stringify(value)).join(', ')}]`;

export function buildTermTemplate(opts: TermTemplateInput): string {
  const identifiers = opts.identifiers ?? [`${termSlug(opts.title)}_id`];
  const tags = opts.tags ?? ['term', opts.domain];
  return `term ${JSON.stringify(opts.title)} {
    domain = ${JSON.stringify(opts.domain)}
    type = ${JSON.stringify(opts.type ?? 'entity')}
    status = ${JSON.stringify(opts.status ?? 'draft')}
    description = ${JSON.stringify(opts.description ?? `Business definition for ${opts.title.toLowerCase()}.`)}
    owner = ${JSON.stringify(opts.owner)}
    tags = ${quoteList(tags)}
    identifiers = ${quoteList(identifiers)}
    synonyms = ${quoteList(opts.synonyms)}
${opts.metricRefs?.length ? `    metricRefs = ${quoteList(opts.metricRefs)}\n` : ''}    businessOwner = ${JSON.stringify(opts.owner)}
    businessRules = ${quoteList(opts.businessRules)}
    caveats = ${quoteList(opts.caveats)}
}
`;
}

/** Where a term of a domain lives on disk, relative to the project root. */
export function termFilePath(domain: string, title: string): string {
  return `domains/${domain}/terms/${termSlug(title)}.dql`;
}
