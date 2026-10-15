import { join } from 'node:path';
import { buildCli, repoRoot } from '../support/server';
import { prepareSample } from './support/sample-project';

/**
 * Global setup for the feature clips: build the CLI (unless E2E_SKIP_BUILD=1)
 * and prepare the Jaffle Shop sample once. The paths reach the clips through
 * the environment, which Playwright workers inherit.
 */
export default async function clipsSetup(): Promise<void> {
  buildCli();
  const workDir = process.env.ZLENS_CLIPS_WORK_DIR || join(repoRoot, 'node_modules', '.cache', 'zlens-clips');
  process.env.ZLENS_CLIPS_WORK_DIR = workDir;
  const sample = prepareSample(join(workDir, 'sample'));
  process.env.ZLENS_CLIPS_CLONE_DIR = sample.cloneDir;
  process.env.ZLENS_CLIPS_TEMPLATE_DIR = sample.templateDir;
  process.env.ZLENS_CLIPS_CONNECTORS_DIR = sample.connectorsDir;
}
