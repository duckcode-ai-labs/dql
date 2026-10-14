/**
 * Digest emitter — App-level CXO daily digest.
 *
 * Consumes a DigestIR (dashboard shape + optional NarrativeIR) plus block source
 * metadata (path + git SHA) and emits:
 *   - HTML: the underlying dashboard output with a narrative section prepended,
 *     every numeric claim carrying a `blocks/…@<sha>` anchor.
 *   - Markdown: the narrative + a source manifest suitable for email body.
 *
 * Citation gate: every numeric claim in the narrative MUST be followed by a
 * `[blocks/…@<sha>]` anchor. Uncited claims are marked `[uncited]` and reported
 * in diagnostics. Referenced blocks without a known SHA are flagged `[stale]`.
 */

import type { DigestIR, NarrativeIR } from '../ir/ir-nodes.js';

export interface BlockSource {
  /** Project-relative path to the block file (e.g. `blocks/finance/revenue.dql`). */
  path: string;
  /** Git commit SHA the block was last committed at, if known. */
  gitCommitSha?: string;
  /** Human-readable description, passed to the LLM as grounding. */
  description?: string;
}

/** Map of block name → source metadata. Keys are DQL block names (what `ref()` uses). */
export type BlockSourceMap = Map<string, BlockSource>;

/**
 * Minimal LLM provider contract for digest narrative generation.
 *
 * Implementations MUST be BYOK — the digest compiler must not carry any LLM
 * keys or vendor SDKs by default. If no provider is supplied, the emitter
 * falls back to a deterministic template.
 */
export interface DigestLLMProvider {
  complete(messages: Array<{ role: 'system' | 'user'; content: string }>): Promise<string>;
}

export interface DigestDiagnostic {
  level: 'warning' | 'error';
  message: string;
}

export interface DigestBuildResult {
  html: string;
  markdown: string;
  narrativeText: string;
  diagnostics: DigestDiagnostic[];
}

/**
 * Build a digest from a DigestIR + base dashboard HTML + source metadata.
 *
 * The caller is responsible for having already produced the dashboard HTML
 * (via emitDashboardHTML) — this avoids pulling theme + runtime + chart-spec
 * dependencies into the digest module.
 */
export async function buildDigest(
  digest: DigestIR,
  dashboardHTML: string,
  sources: BlockSourceMap,
  llm?: DigestLLMProvider,
): Promise<DigestBuildResult> {
  const diagnostics: DigestDiagnostic[] = [];
  const narrative = digest.narrative;

  const { text, narrativeDiagnostics } = await generateNarrative(
    digest.title,
    narrative,
    sources,
    llm,
  );
  diagnostics.push(...narrativeDiagnostics);

  const { cited, gateDiagnostics } = enforceCitations(text, narrative, sources);
  diagnostics.push(...gateDiagnostics);

  const html = composeDigestHTML(digest.title, cited, dashboardHTML, narrative, sources);
  const markdown = composeDigestMarkdown(digest.title, cited, narrative, sources);

  return { html, markdown, narrativeText: cited, diagnostics };
}

async function generateNarrative(
  title: string,
  narrative: NarrativeIR | undefined,
  sources: BlockSourceMap,
  llm: DigestLLMProvider | undefined,
): Promise<{ text: string; narrativeDiagnostics: DigestDiagnostic[] }> {
  const narrativeDiagnostics: DigestDiagnostic[] = [];

  if (!narrative || !narrative.prompt) {
    // No narrative body — emit a plain header line and skip the LLM call.
    return { text: `Digest for ${title}.`, narrativeDiagnostics };
  }

  if (!llm) {
    // Deterministic fallback. Produces a safe, citation-valid paragraph the
    // citation gate can pass. Lets `zlens build` succeed without an API key.
    const bullets = narrative.sources.map((name) => {
      const src = sources.get(name);
      const cite = formatCitation(name, src);
      return `- Source reference: ${name} ${cite}.`;
    });
    const header = `Auto-generated digest for ${title}. Prompt: "${narrative.prompt}".`;
    return {
      text: [header, '', ...bullets].join('\n'),
      narrativeDiagnostics,
    };
  }

  const system =
    'You are drafting a daily executive digest. Every numeric claim you make MUST be immediately followed by a citation in the form [<path>@<sha>] pulled from the provided sources. Never invent block names or SHAs. If a claim cannot be tied to a provided source, omit it.';
  const sourceSection = narrative.sources
    .map((name) => {
      const src = sources.get(name);
      if (!src) return `- ${name} [MISSING — do not cite]`;
      const sha = src.gitCommitSha ?? 'nosha';
      const desc = src.description ? `: ${src.description}` : '';
      return `- ${name} → [${src.path}@${sha}]${desc}`;
    })
    .join('\n');
  const user = `Title: ${title}\nPrompt: ${narrative.prompt}\nAvailable sources (cite verbatim):\n${sourceSection}`;

  try {
    const text = await llm.complete([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]);
    return { text, narrativeDiagnostics };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    narrativeDiagnostics.push({
      level: 'warning',
      message: `LLM call failed (${message}); falling back to deterministic narrative.`,
    });
    return generateNarrative(title, narrative, sources, undefined);
  }
}

/**
 * Enforce the citation gate. Every numeric claim (integers, decimals, percents,
 * optional currency markers) outside an existing `[<path>@<sha>]` anchor must
 * be followed — within 120 characters — by such an anchor. Missing anchors get
 * an `[uncited]` marker appended; missing SHAs are flagged `[stale]`.
 */
function enforceCitations(
  text: string,
  narrative: NarrativeIR | undefined,
  sources: BlockSourceMap,
): { cited: string; gateDiagnostics: DigestDiagnostic[] } {
  const gateDiagnostics: DigestDiagnostic[] = [];
  if (!narrative) return { cited: text, gateDiagnostics };

  // First: mark blocks referenced in citations that have no SHA as [stale].
  // Anchor form is `[<path>@<sha>]`; path must contain a path-separator or a
  // `.dql` suffix to avoid matching generic bracketed text like `[uncited]`.
  const anchorPattern = /\[((?:[^\]@\s]+\/)?[^\]@\s]+\.dql)(?:@([^\]]*))?\]/g;
  const staleMarked = text.replace(
    anchorPattern,
    (match, path: string, sha: string | undefined) => {
      const name = findSourceNameForPath(path, sources);
      const src = name ? sources.get(name) : undefined;
      if (!src) {
        gateDiagnostics.push({
          level: 'warning',
          message: `Citation references unknown path "${path}"; marked [stale].`,
        });
        return `${match.replace(/\]$/, '')}[stale]]`;
      }
      if (!sha || !src.gitCommitSha || sha !== src.gitCommitSha) {
        gateDiagnostics.push({
          level: 'warning',
          message: `Citation SHA for "${path}" missing or stale; marked [stale].`,
        });
        return `[${path}@${src.gitCommitSha ?? 'nosha'}][stale]`;
      }
      return match;
    },
  );

  // Collect anchor ranges so the numeric-claim scan can skip digits that live
  // inside a SHA (otherwise "7abcdef…" trips the gate on its leading "7").
  const anchorRanges: Array<[number, number]> = [];
  const rangeScan = new RegExp(anchorPattern.source, 'g');
  let anchor: RegExpExecArray | null;
  while ((anchor = rangeScan.exec(staleMarked)) !== null) {
    anchorRanges.push([anchor.index, anchor.index + anchor[0].length]);
  }
  const isInsideAnchor = (idx: number): boolean =>
    anchorRanges.some(([s, e]) => idx >= s && idx < e);

  // Second: append [uncited] to numeric claims that have no citation within 120 chars.
  const numericClaim = /(?<![\w])(?:\$|€|£)?\d[\d,]*(?:\.\d+)?%?/g;
  let cited = '';
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  while ((match = numericClaim.exec(staleMarked)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    cited += staleMarked.slice(lastIdx, end);
    lastIdx = end;
    if (isInsideAnchor(start)) continue;
    const tail = staleMarked.slice(end, Math.min(staleMarked.length, end + 120));
    const hasCitation = /\[[^\]]+\.dql(?:@[^\]]+)?\]/.test(tail);
    if (!hasCitation) {
      cited += ' [uncited]';
      gateDiagnostics.push({
        level: 'warning',
        message: `Numeric claim "${match[0]}" has no citation within 120 chars; marked [uncited].`,
      });
    }
  }
  cited += staleMarked.slice(lastIdx);

  return { cited, gateDiagnostics };
}

function findSourceNameForPath(path: string, sources: BlockSourceMap): string | undefined {
  for (const [name, src] of sources) {
    if (src.path === path) return name;
  }
  return undefined;
}

function formatCitation(name: string, src: BlockSource | undefined): string {
  if (!src) return `[${name}@stale]`;
  const sha = src.gitCommitSha ?? 'nosha';
  return `[${src.path}@${sha}]`;
}

function composeDigestHTML(
  title: string,
  narrativeText: string,
  dashboardHTML: string,
  narrative: NarrativeIR | undefined,
  sources: BlockSourceMap,
): string {
  const paragraphs = narrativeText
    .split(/\n{2,}/)
    .map((p) => `<p>${linkifyCitations(escapeHTML(p))}</p>`)
    .join('\n');
  const sourceList = narrative
    ? narrative.sources
        .map((name) => {
          const src = sources.get(name);
          const path = src?.path ?? name;
          const sha = src?.gitCommitSha ?? 'stale';
          return `<li><code>${escapeHTML(name)}</code> — <code>${escapeHTML(path)}@${escapeHTML(sha)}</code></li>`;
        })
        .join('\n')
    : '';

  const narrativeSection = `
    <section class="dql-digest-narrative" style="padding: 24px; max-width: 860px; margin: 0 auto; font-family: system-ui, -apple-system, sans-serif;">
      <h1 style="margin-bottom: 8px;">${escapeHTML(title)}</h1>
      <div class="dql-digest-body">
        ${paragraphs}
      </div>
      ${sourceList ? `<details style="margin-top: 16px; color: #555;"><summary>Sources</summary><ul>${sourceList}</ul></details>` : ''}
    </section>
  `;

  // Inject the narrative after the opening <body> of the dashboard HTML so the
  // digest stays a single self-contained document (works as email body or
  // standalone HTML file).
  if (dashboardHTML.includes('<body>')) {
    return dashboardHTML.replace('<body>', `<body>${narrativeSection}`);
  }
  return `${narrativeSection}\n${dashboardHTML}`;
}

function composeDigestMarkdown(
  title: string,
  narrativeText: string,
  narrative: NarrativeIR | undefined,
  sources: BlockSourceMap,
): string {
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(narrativeText);
  lines.push('');
  if (narrative && narrative.sources.length > 0) {
    lines.push('## Sources');
    for (const name of narrative.sources) {
      const src = sources.get(name);
      const path = src?.path ?? name;
      const sha = src?.gitCommitSha ?? 'stale';
      lines.push(`- \`${name}\` — \`${path}@${sha}\``);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function linkifyCitations(text: string): string {
  return text.replace(
    /\[((?:[^\]@\s]+\/)?[^\]@\s]+\.dql(?:@[^\]]+)?)\]/g,
    (_m, body: string) =>
      `<code class="dql-digest-cite" style="background:#f2f2f2;padding:1px 4px;border-radius:3px;font-size:0.85em;">${body}</code>`,
  );
}

function escapeHTML(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
