import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { readEnv } from '@zlens/core';

export interface NpmInvocation {
  command: string;
  argsPrefix: string[];
  source: 'override' | 'npm_execpath' | 'node_sibling' | 'node_install' | 'path';
}

interface ResolveNpmInvocationOptions {
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
}

/**
 * Resolve npm without assuming the process inherited an interactive-shell
 * PATH. macOS GUI-launched notebook processes commonly retain Node's absolute
 * executable but omit Homebrew or nvm from PATH; npm normally lives beside
 * that executable or in its adjacent lib/node_modules tree.
 *
 * E2E-005: connector installation must work from the same built CLI whether
 * it was launched by a shell, an npm script, or the desktop/browser UI.
 */
export function resolveNpmInvocation(options: ResolveNpmInvocationOptions = {}): NpmInvocation {
  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const pathApi = platform === 'win32' ? win32 : posix;

  const override = readEnv('ZLENS_NPM_EXEC_PATH', env)?.trim();
  if (override) {
    if (!exists(override)) {
      throw new Error(`ZLENS_NPM_EXEC_PATH points to a missing file: ${override}`);
    }
    return invocationFor(override, execPath, 'override');
  }

  const npmExecPath = env.npm_execpath?.trim();
  if (npmExecPath && isNpmExecutable(npmExecPath) && exists(npmExecPath)) {
    return invocationFor(npmExecPath, execPath, 'npm_execpath');
  }

  const npmCliCandidates = platform === 'win32'
    ? [pathApi.join(pathApi.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')]
    : [pathApi.join(pathApi.dirname(execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  for (const npmCli of npmCliCandidates) {
    if (exists(npmCli)) {
      return { command: execPath, argsPrefix: [npmCli], source: 'node_install' };
    }
  }

  const sibling = pathApi.join(pathApi.dirname(execPath), platform === 'win32' ? 'npm.cmd' : 'npm');
  if (exists(sibling)) {
    return invocationFor(sibling, execPath, 'node_sibling');
  }

  for (const directory of (env.PATH ?? '').split(pathApi.delimiter).filter(Boolean)) {
    const candidate = pathApi.join(directory, platform === 'win32' ? 'npm.cmd' : 'npm');
    if (exists(candidate)) {
      return { command: candidate, argsPrefix: [], source: 'path' };
    }
  }

  throw new Error(
    'npm executable was not found. Install Node.js with npm, add npm to PATH, '
      + 'or set ZLENS_NPM_EXEC_PATH to the absolute npm executable. '
      + 'ZLens only invokes npm to install optional project-local connector drivers.',
  );
}

export function describeNpmInvocation(invocation: NpmInvocation): string {
  return invocation.argsPrefix.length > 0
    ? `${invocation.command} ${invocation.argsPrefix.join(' ')}`
    : invocation.command;
}

function invocationFor(
  npmPath: string,
  execPath: string,
  source: NpmInvocation['source'],
): NpmInvocation {
  if (/\.(?:c?js|mjs)$/i.test(npmPath)) {
    return { command: execPath, argsPrefix: [npmPath], source };
  }
  if (/\.cmd$/i.test(npmPath)) {
    return {
      command: 'cmd.exe',
      argsPrefix: ['/d', '/s', '/c', `"${npmPath}"`],
      source,
    };
  }
  return { command: npmPath, argsPrefix: [], source };
}

function isNpmExecutable(path: string): boolean {
  return /(?:^|[\\/])npm(?:-cli)?(?:\.(?:cmd|c?js|mjs))?$/i.test(path);
}
