import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { QueryExecutor } from '@duckcodeailabs/dql-connectors';
import type { CLIFlags } from '../args.js';
import { assertLocalQueryRuntimeReady, findProjectRoot, loadProjectConfig, normalizeProjectConnection, startLocalServer } from '../local-runtime.js';
import { maybeOpenBrowser } from '../open-browser.js';

export async function runServe(targetDir: string | null, flags: CLIFlags): Promise<void> {
  const rootDir = resolve(targetDir || 'dist');
  if (!existsSync(join(rootDir, 'index.html'))) {
    throw new Error(`No built DQL bundle found at ${rootDir}. Run "dql build <file.dql>" first or pass a directory containing index.html.`);
  }
  const projectRoot = findProjectRoot(rootDir);
  const config = loadProjectConfig(projectRoot);
  const executor = new QueryExecutor();
  const connection = config.defaultConnection
    ? normalizeProjectConnection(config.defaultConnection, projectRoot)
    : { driver: 'file' as const, filepath: ':memory:' };

  process.chdir(projectRoot);
  await assertLocalQueryRuntimeReady(executor, connection);
  const port = await startLocalServer({
    rootDir,
    executor,
    connection,
    preferredPort: flags.port ?? config.preview?.port ?? 3474,
  });
  const url = `http://127.0.0.1:${port}`;
  maybeOpenBrowser(url, flags.open ?? config.preview?.open ?? true);

  console.log(`\n  ✓ Serving DQL bundle: ${url}`);
  console.log(`    Root: ${rootDir}`);
  console.log('    Press Ctrl+C to stop.');
  console.log('');
}
