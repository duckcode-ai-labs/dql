import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { Page } from '@playwright/test';
import type { Director } from './director';

/**
 * A terminal for the clips that show commands (quickstart, mcp-connect).
 *
 * Commands are really run by the harness; the page shows the command being
 * typed and then the output that run printed (ANSI colours kept). The only
 * edit to output is cosmetic: the scratch directory the clip runs in is shown
 * as `~`, so no local path of the person recording appears.
 */

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; height: 100%; background: #f4f1ea; font-family: Inter, -apple-system, system-ui, sans-serif; }
  .win { position: absolute; inset: 44px 72px; background: #15171a; border-radius: 12px; overflow: hidden;
    box-shadow: 0 24px 60px rgba(20, 20, 20, .28); display: flex; flex-direction: column; }
  .bar { height: 38px; background: #24272b; display: flex; align-items: center; padding: 0 14px; gap: 8px; flex: none; }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .title { color: #a9adb3; font-size: 13px; margin-left: 12px; }
  .body { flex: 1; padding: 18px 22px; overflow: hidden; color: #e6e6e6;
    font: 15px/1.55 "SF Mono", Menlo, "DejaVu Sans Mono", Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
  .prompt { color: #5fd3bc; } .cwd { color: #8ab4f8; }
  .cursor { display: inline-block; width: 9px; height: 18px; background: #e6e6e6; vertical-align: -3px; animation: blink 1s steps(1) infinite; }
  @keyframes blink { 50% { opacity: 0 } }
  .b { font-weight: 700; } .d { opacity: .62; }
  .c31 { color: #ff7b72; } .c32 { color: #7ee787; } .c33 { color: #e3b341; } .c34 { color: #79c0ff; } .c35 { color: #d2a8ff; } .c36 { color: #56d4dd; }
</style></head><body><div class="win"><div class="bar">
  <span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span>
  <span class="title" id="title"></span></div><div class="body" id="body"></div></div>
<script>
  const body = document.getElementById('body');
  let line = null;
  const keepBottom = () => { body.scrollTop = body.scrollHeight; };
  window.__term = {
    title(text) { document.getElementById('title').textContent = text; },
    prompt(cwd) {
      document.querySelectorAll('.cursor').forEach((c) => c.remove());
      line = document.createElement('div');
      line.innerHTML = '<span class="cwd"></span> <span class="prompt">$</span> <span class="cmd"></span><span class="cursor"></span>';
      line.querySelector('.cwd').textContent = cwd;
      body.appendChild(line); keepBottom();
    },
    key(ch) { line.querySelector('.cmd').textContent += ch; keepBottom(); },
    enter() { document.querySelectorAll('.cursor').forEach((c) => c.remove()); },
    print(html) { const out = document.createElement('div'); out.innerHTML = html; body.appendChild(out); keepBottom(); },
    clear() { body.innerHTML = ''; },
  };
</script></body></html>`;

/**
 * The environment a person's own shell would have: without the variables
 * pnpm and npm set for the harness (create-zlens-app reads the package manager
 * from npm_config_user_agent and would otherwise print pnpm commands).
 */
export function shellEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(npm_|pnpm_|PNPM_|INIT_CWD$|PLAYWRIGHT_|TEST_)/i.test(key)) continue;
    env[key] = value;
  }
  return { ...env, FORCE_COLOR: '1', ...extra };
}

const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Convert the SGR colour codes CLIs print into spans; drop every other escape. */
export function ansiToHtml(text: string): string {
  let open = 0;
  let html = '';
  const parts = text.replace(/\r(?!\n)/g, '').split(/(\x1b\[[0-9;]*m)/);
  for (const part of parts) {
    const sgr = /^\x1b\[([0-9;]*)m$/.exec(part);
    if (!sgr) {
      html += escape(part.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
      continue;
    }
    const codes = sgr[1] ? sgr[1].split(';').map(Number) : [0];
    for (const code of codes) {
      if (code === 0 || code === 22 || code === 39) {
        html += '</span>'.repeat(open);
        open = 0;
      } else if (code === 1) {
        html += '<span class="b">';
        open += 1;
      } else if (code === 2) {
        html += '<span class="d">';
        open += 1;
      } else if (code >= 31 && code <= 36) {
        html += `<span class="c${code}">`;
        open += 1;
      }
    }
  }
  return html + '</span>'.repeat(open);
}

export interface Captured {
  output: string;
  status: number | null;
}

/** Run a command to completion and capture stdout + stderr in order. */
export function runCaptured(command: string, options: { cwd: string; env?: NodeJS.ProcessEnv }): Captured {
  const result = spawnSync('/bin/sh', ['-c', `${command} 2>&1`], {
    cwd: options.cwd,
    env: shellEnv(options.env),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return { output: result.stdout ?? '', status: result.status };
}

/** Start a long-running command; resolve once its output matches `ready`. */
export function startCaptured(command: string, options: { cwd: string; env?: NodeJS.ProcessEnv; ready: RegExp; timeout?: number }): Promise<{ child: ChildProcess; output: string; match: RegExpExecArray; stop: () => void }> {
  return new Promise((resolveStart, reject) => {
    const child = spawn('/bin/sh', ['-c', `exec ${command} 2>&1`], {
      cwd: options.cwd,
      env: shellEnv(options.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // its own process group, so stop() also ends what npm started
    });
    const stop = (): void => {
      try {
        process.kill(-child.pid!, 'SIGTERM');
      } catch {
        // already gone
      }
    };
    let output = '';
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`Timed out waiting for ${options.ready} from \`${command}\`:\n${output}`));
    }, options.timeout ?? 180_000);
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const match = options.ready.exec(output.replace(/\x1b\[[0-9;]*m/g, ''));
      if (match) {
        clearTimeout(timer);
        resolveStart({ child, output, match, stop });
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`\`${command}\` exited with ${code} before it was ready:\n${output}`));
    });
  });
}

export class Terminal {
  constructor(private readonly page: Page, private readonly director: Director, private readonly hide: Array<[string, string]> = []) {}

  async open(title: string): Promise<void> {
    await this.page.setContent(PAGE);
    await this.page.evaluate((text) => (window as unknown as { __term: { title(t: string): void } }).__term.title(text), title);
  }

  private clean(text: string): string {
    let out = text;
    for (const [from, to] of this.hide) out = out.split(from).join(to);
    return out;
  }

  async prompt(cwd: string): Promise<void> {
    await this.page.evaluate((dir) => (window as unknown as { __term: { prompt(d: string): void } }).__term.prompt(dir), cwd);
  }

  /** Type a command at a readable pace and press Enter. */
  async type(command: string): Promise<void> {
    await this.director.beat(450);
    for (const ch of command) {
      await this.page.evaluate((c) => (window as unknown as { __term: { key(c: string): void } }).__term.key(c), ch);
      await this.page.waitForTimeout(42);
    }
    await this.director.beat(350);
    await this.page.evaluate(() => (window as unknown as { __term: { enter(): void } }).__term.enter());
  }

  /** Print output a few lines at a time, the way a CLI scrolls. */
  async print(output: string, linesPerStep = 3): Promise<void> {
    const lines = this.clean(output).replace(/\n+$/, '').split('\n');
    for (let i = 0; i < lines.length; i += linesPerStep) {
      const html = lines.slice(i, i + linesPerStep).map((l) => ansiToHtml(l) || ' ').join('\n');
      await this.page.evaluate((h) => (window as unknown as { __term: { print(h: string): void } }).__term.print(h), html);
      await this.page.waitForTimeout(70);
    }
    await this.director.beat(500);
  }
}
