import { test as base, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));

// DIAGNOSTIC BRANCH ONLY: on a hang, pause V8 and print the JS stack.
export const test = base.extend({
  baseURL: async ({}, use) => {
    const url = process.env.DQL_E2E_BASE_URL;
    if (!url) throw new Error('DQL_E2E_BASE_URL is not set: global setup did not start the server.');
    await use(url);
  },
  page: async ({ page }, use, testInfo) => {
    const tag = `[diag ${testInfo.title.slice(0, 30)}]`;
    page.on('console', (m) => console.log(tag, 'console', m.type(), m.text().slice(0, 300)));
    page.on('pageerror', (e) => console.log(tag, 'pageerror', String(e).slice(0, 500)));
    page.on('crash', () => console.log(tag, 'CRASH'));
    page.on('dialog', (d) => console.log(tag, 'dialog', d.type(), d.message()));
    page.on('request', (r) => { if (process.env.E2E_DIAG_NET) console.log(tag, 'req', Date.now() % 100000, r.method(), r.url().slice(0, 120)); });
    page.on('requestfinished', (r) => { if (process.env.E2E_DIAG_NET) console.log(tag, 'fin', Date.now() % 100000, r.url().slice(0, 120)); });
    page.on('requestfailed', (r) => console.log(tag, 'reqfailed', r.url().slice(0, 120), r.failure()?.errorText));
    const cdp = await page.context().newCDPSession(page);
    const debuggerUpfront = process.env.E2E_DIAG_DEBUGGER === '1';
    if (debuggerUpfront) await cdp.send('Debugger.enable');
    const scripts = new Map<string, string>();
    cdp.on('Debugger.scriptParsed', (e) => scripts.set(e.scriptId, e.url));
    cdp.on('Debugger.paused', (e) => {
      console.log(tag, 'PAUSED reason', e.reason);
      for (const f of e.callFrames.slice(0, 40)) {
        console.log(tag, '  at', f.functionName || '<anon>', f.url || scripts.get(f.location.scriptId), `${f.location.lineNumber + 1}:${(f.location.columnNumber ?? 0) + 1}`);
      }
      void cdp.send('Debugger.resume').catch(() => undefined);
    });
    const timers = [20_000, 30_000, 40_000].map((ms) => setTimeout(() => {
      console.log(tag, `WATCHDOG ${ms}ms: sending Debugger.pause`);
      if (ms === 20_000 && process.platform === 'linux') {
        execFile('bash', [join(here, 'hang-dump.sh')], { timeout: 60_000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
          console.log(stdout); if (stderr) console.log('hang-dump stderr:', stderr.slice(0, 2000)); if (err) console.log('hang-dump error:', String(err));
        });
      }
      if (!debuggerUpfront) void cdp.send('Debugger.enable').then(() => console.log(tag, 'late Debugger.enable ok')).catch((err) => console.log(tag, 'late enable failed', String(err)));
      void cdp.send('Debugger.pause').then(() => console.log(tag, 'pause ack')).catch((err) => console.log(tag, 'pause failed', String(err)));
      void cdp.send('Runtime.evaluate', { expression: '1+1', timeout: 2000 }).then(() => console.log(tag, 'evaluate ok')).catch((err) => console.log(tag, 'evaluate failed', String(err)));
    }, ms));
    await use(page);
    timers.forEach(clearTimeout);
  },
});

export { expect };
