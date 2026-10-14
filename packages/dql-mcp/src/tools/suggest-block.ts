import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Certifier } from '@zlens/governance';
import type { BlockRecord, BlockStatus } from '@zlens/project';
import type { DQLContext } from '../context.js';
import { zodInputShapeForTool } from '../tool-schema.js';

export const suggestBlockInput = zodInputShapeForTool('suggest_block');

/**
 * Write a proposed block to the local draft queue and return the governance
 * gate result. Never auto-certifies — the human still has to review and move
 * the file.
 */
export function suggestBlock(
  ctx: DQLContext,
  args: {
    name: string;
    domain: string;
    owner: string;
    description: string;
    sql: string;
    tags?: string[];
    chartType?: string;
  },
) {
  const safeName = args.name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  if (!safeName) return { error: 'Invalid block name.' };
  const draftPath = resolveDraftPath(ctx.projectRoot, args.domain, safeName);

  const now = new Date();
  const record: BlockRecord = {
    id: safeName,
    name: safeName,
    domain: args.domain,
    type: args.chartType ? 'chart' : 'block',
    version: '0.1.0',
    status: 'draft' as BlockStatus,
    gitRepo: '',
    gitPath: draftPath,
    gitCommitSha: '',
    description: args.description,
    owner: args.owner,
    tags: args.tags ?? [],
    dependencies: [],
    usedInCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  const certification = new Certifier().evaluate(record);

  const filePath = join(ctx.projectRoot, draftPath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, renderBlock(args, safeName));
  ctx.refresh();

  return {
    name: safeName,
    path: draftPath,
    certified: certification.certified,
    errors: certification.errors,
    warnings: certification.warnings,
    nextStep: certification.certified
      ? 'Draft saved and passes governance. Move to the appropriate domain folder and commit.'
      : 'Draft saved but does NOT pass governance. Address errors before promotion.',
  };
}

function resolveDraftPath(projectRoot: string, domain: string, safeName: string): string {
  const safeDomain = domain
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/^\/+|\/+$/g, '');
  if (safeDomain && existsSync(join(projectRoot, 'domains', safeDomain))) {
    return `domains/${safeDomain}/blocks/_drafts/${safeName}.dql`;
  }
  return `blocks/_drafts/${safeName}.dql`;
}

function renderBlock(
  args: {
    name: string;
    domain: string;
    owner: string;
    description: string;
    sql: string;
    tags?: string[];
    chartType?: string;
  },
  safeName: string,
): string {
  const tagsLine = args.tags?.length ? `\n  tags = [${args.tags.map((t) => `"${t}"`).join(', ')}]` : '';
  const chartLine = args.chartType
    ? `\n\n  visualization {\n    chart = "${args.chartType}"\n  }`
    : '';
  const descEscaped = args.description.replace(/"/g, '\\"');
  return `// dql-format: 1
block "${safeName}" {
  domain = "${args.domain}"
  owner = "${args.owner}"
  description = "${descEscaped}"${tagsLine}

  query {
    sql = """
${args.sql.trimEnd()}
    """
  }${chartLine}
}
`;
}
