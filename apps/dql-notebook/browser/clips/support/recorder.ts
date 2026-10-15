import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CDPSession, Page } from '@playwright/test';

/**
 * Records a page as timestamped JPEG frames through the Chrome DevTools
 * screencast. Playwright's own video is a fixed low-bitrate VP8 that blurs
 * UI text; the screencast keeps every repaint sharp, and its timestamps let the
 * encoder (scripts/docs-clips/encode.mjs) shorten waits instead of showing them.
 *
 * Output: <dir>/frames/*.jpg and <dir>/timeline.json
 *   { start, end, frames: [{ file, ts }], cuts: [[from, to]], poster }
 * All times are seconds on the screencast clock (seconds since the epoch).
 */

export interface Timeline {
  start: number;
  end: number;
  frames: Array<{ file: string; ts: number }>;
  /** Spans to compress to a short beat: waits on the server, not product moments. */
  cuts: Array<[number, number]>;
  /** The moment the poster image is taken from. */
  poster?: number;
}

export class ScreencastRecorder {
  private session?: CDPSession;
  private frames: Timeline['frames'] = [];
  private cuts: Timeline['cuts'] = [];
  private openCut?: number;
  private posterAt?: number;
  private start = 0;
  private count = 0;
  private writes: Promise<void>[] = [];

  constructor(private readonly page: Page, private readonly dir: string) {}

  private now(): number {
    return Date.now() / 1000;
  }

  async begin(): Promise<void> {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(join(this.dir, 'frames'), { recursive: true });
    this.session = await this.page.context().newCDPSession(this.page);
    this.start = this.now();
    this.session.on('Page.screencastFrame', (event) => {
      const file = `frames/${String(++this.count).padStart(6, '0')}.jpg`;
      this.frames.push({ file, ts: event.metadata.timestamp ?? this.now() });
      this.writes.push(Promise.resolve().then(() => writeFileSync(join(this.dir, file), Buffer.from(event.data, 'base64'))));
      void this.session?.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => undefined);
    });
    await this.session.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1440, maxHeight: 900, everyNthFrame: 1 });
    // Force a first frame even if nothing repaints for a while.
    await this.page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(null))));
  }

  /** Start a span the final clip compresses (a server wait, not a product moment). */
  cutStart(): void {
    if (this.openCut === undefined) this.openCut = this.now();
  }

  cutEnd(): void {
    if (this.openCut === undefined) return;
    this.cuts.push([this.openCut, this.now()]);
    this.openCut = undefined;
  }

  /** Mark now as the poster frame. */
  poster(): void {
    this.posterAt = this.now();
  }

  async finish(succeeded = true): Promise<Timeline | undefined> {
    if (!this.session) return undefined; // never started: nothing to write
    this.cutEnd();
    const end = this.now();
    try {
      await this.session?.send('Page.stopScreencast');
    } catch {
      // the page may already be closing
    }
    await Promise.all(this.writes);
    await this.session?.detach().catch(() => undefined);
    const timeline: Timeline = {
      start: this.start,
      end,
      frames: this.frames,
      cuts: this.cuts,
      ...(this.posterAt ? { poster: this.posterAt } : {}),
    };
    writeFileSync(join(this.dir, succeeded ? 'timeline.json' : 'timeline.failed.json'), `${JSON.stringify(timeline, null, 2)}\n`);
    return timeline;
  }
}
