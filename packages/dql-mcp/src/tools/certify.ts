import { Certifier } from '@zlens/governance';
import type { DQLContext } from '../context.js';
import { manifestBlockToRecord } from './util.js';
import { zodInputShapeForTool } from '../tool-schema.js';

export const certifyInput = zodInputShapeForTool('certify');

export function certify(ctx: DQLContext, args: { name: string }) {
  const manifestBlock = ctx.manifest.blocks[args.name];
  if (!manifestBlock) return { error: `No block named "${args.name}".` };

  const record = manifestBlockToRecord(manifestBlock);
  const result = new Certifier().evaluate(record);

  return {
    block: args.name,
    path: manifestBlock.filePath,
    certified: result.certified,
    errors: result.errors,
    warnings: result.warnings,
    checkedAt: result.checkedAt.toISOString(),
  };
}
