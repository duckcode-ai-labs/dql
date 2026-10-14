import { describe, expect, it } from 'vitest';
import { describeNpmInvocation, resolveNpmInvocation } from './npm-runtime.js';

describe('resolveNpmInvocation (E2E-005)', () => {
  it('finds npm beside the running Node executable when PATH is empty', () => {
    const npmPath = '/opt/node/bin/npm';
    const invocation = resolveNpmInvocation({
      execPath: '/opt/node/bin/node',
      env: { PATH: '' },
      platform: 'darwin',
      exists: (path) => path === npmPath,
    });

    expect(invocation).toEqual({
      command: npmPath,
      argsPrefix: [],
      source: 'node_sibling',
    });
  });

  it('runs npm_execpath JavaScript through the current Node executable', () => {
    const npmCli = '/opt/node/lib/node_modules/npm/bin/npm-cli.js';
    const invocation = resolveNpmInvocation({
      execPath: '/opt/node/bin/node',
      env: { PATH: '', npm_execpath: npmCli },
      platform: 'darwin',
      exists: (path) => path === npmCli,
    });

    expect(invocation).toEqual({
      command: '/opt/node/bin/node',
      argsPrefix: [npmCli],
      source: 'npm_execpath',
    });
    expect(describeNpmInvocation(invocation)).toBe(`/opt/node/bin/node ${npmCli}`);
  });

  it('uses the npm CLI JavaScript bundled with Windows Node before npm.cmd', () => {
    const npmCli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
    const invocation = resolveNpmInvocation({
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      env: { PATH: '' },
      platform: 'win32',
      exists: (path) => path === npmCli,
    });

    expect(invocation).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      argsPrefix: [npmCli],
      source: 'node_install',
    });
  });

  it('returns an actionable error when npm is genuinely unavailable', () => {
    expect(() => resolveNpmInvocation({
      execPath: '/opt/node/bin/node',
      env: { PATH: '' },
      platform: 'darwin',
      exists: () => false,
    })).toThrow('ZLENS_NPM_EXEC_PATH');
  });
});
