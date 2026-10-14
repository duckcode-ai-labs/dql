import { readFileSync } from 'node:fs';
import { Parser } from '@zlens/core';
import { CostEstimator } from '@zlens/governance';
import type { CLIFlags } from '../args.js';

export async function runInfo(filePath: string, flags: CLIFlags): Promise<void> {
  const source = readFileSync(filePath, 'utf-8');
  const parser = new Parser(source, filePath);
  const ast = parser.parse();

  const blocks = ast.statements.filter((s: any) => s.kind === 'BlockDecl');

  if (blocks.length === 0) {
    console.log('\n  ⚠ No block declarations found in file.');
    console.log('');
    return;
  }

  const estimator = new CostEstimator();

  for (const block of blocks) {
    const b = block as any;
    const sql = queryToSql(b.query);

    if (flags.format === 'json') {
      const cost = sql ? estimator.estimate(sql) : null;
      console.log(JSON.stringify({
        name: b.name,
        domain: b.domain,
        type: b.blockType ?? b.type,
        description: b.description,
        owner: b.owner,
        tags: b.tags,
        query: sql,
        params: b.params,
        tests: b.tests?.length ?? 0,
        costEstimate: cost,
      }, null, 2));
      continue;
    }

    console.log(`\n  Block: "${b.name ?? 'unnamed'}"`);
    console.log(`    Domain:      ${b.domain ?? '(none)'}`);
    console.log(`    Type:        ${b.blockType ?? b.type ?? '(none)'}`);
    console.log(`    Owner:       ${b.owner ?? '(none)'}`);
    console.log(`    Description: ${b.description ?? '(none)'}`);
    console.log(`    Tags:        ${b.tags?.length ? b.tags.join(', ') : '(none)'}`);
    console.log(`    Params:      ${b.params?.length ?? 0}`);
    console.log(`    Tests:       ${b.tests?.length ?? 0} assertion(s)`);

    if (sql) {
      const cost = estimator.estimate(sql);
      console.log(`\n    Cost Estimate: ${cost.score}/100`);
      if (cost.recommendation) {
        console.log(`    → ${cost.recommendation}`);
      }
      if (cost.factors.length > 0 && flags.verbose) {
        for (const f of cost.factors) {
          console.log(`      • ${f.name} (+${f.impact}): ${f.description}`);
        }
      }
    }
  }
  console.log('');
}

function queryToSql(query: unknown): string | null {
  if (typeof query === 'string') return query;
  if (!query || typeof query !== 'object') return null;
  const q = query as { rawSQL?: unknown; sql?: unknown; value?: unknown };
  if (typeof q.rawSQL === 'string') return q.rawSQL;
  if (typeof q.sql === 'string') return q.sql;
  if (typeof q.value === 'string') return q.value;
  return null;
}
