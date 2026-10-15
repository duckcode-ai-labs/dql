import type { BrowserContext, Locator, Page } from '@playwright/test';
import type { ScreencastRecorder } from './recorder';

/**
 * Pacing and a visible pointer for the clips. Headless Chromium draws no
 * cursor, so a small pointer is injected into every page; it follows the real
 * mouse events Playwright sends and pulses on click, so a viewer can see what
 * is clicked. Moves are eased and every action is followed by a short beat.
 */

const POINTER_SCRIPT = `(() => {
  if (window.__clipPointer) return;
  window.__clipPointer = true;
  const install = () => {
    if (!document.body || document.getElementById('__clip-pointer')) return;
    const style = document.createElement('style');
    style.textContent = \`
      #__clip-pointer { position: fixed; left: 0; top: 0; width: 22px; height: 22px; z-index: 2147483647;
        pointer-events: none; transform: translate(-100px, -100px); transition: none; }
      #__clip-pointer svg { filter: drop-shadow(0 1px 2px rgba(0,0,0,.35)); }
      .__clip-ripple { position: fixed; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%;
        border: 2px solid rgba(11,122,117,.9); background: rgba(11,122,117,.18); z-index: 2147483646;
        pointer-events: none; animation: __clip-ripple .55s ease-out forwards; }
      @keyframes __clip-ripple { from { transform: scale(.35); opacity: 1 } to { transform: scale(1.25); opacity: 0 } }
    \`;
    document.head.appendChild(style);
    const pointer = document.createElement('div');
    pointer.id = '__clip-pointer';
    pointer.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2 L3 18 L7.5 14 L10.5 20.5 L13.2 19.3 L10.3 12.9 L16.5 12.9 Z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.body.appendChild(pointer);
    const last = window.__clipPointerAt || { x: -100, y: -100 };
    pointer.style.transform = 'translate(' + last.x + 'px,' + last.y + 'px)';
    document.addEventListener('mousemove', (e) => {
      window.__clipPointerAt = { x: e.clientX, y: e.clientY };
      pointer.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)';
    }, true);
    document.addEventListener('mousedown', (e) => {
      const ripple = document.createElement('div');
      ripple.className = '__clip-ripple';
      ripple.style.left = e.clientX + 'px';
      ripple.style.top = e.clientY + 'px';
      document.body.appendChild(ripple);
      setTimeout(() => ripple.remove(), 600);
    }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
  new MutationObserver(install).observe(document.documentElement, { childList: true, subtree: false });
})();`;

/** Inject the pointer into every page of the context and pin the theme. */
export async function prepareContext(context: BrowserContext, theme = 'paper'): Promise<void> {
  await context.addInitScript(`try { localStorage.setItem('dql-theme', ${JSON.stringify(theme)}); } catch {}`);
  await context.addInitScript(POINTER_SCRIPT);
}

export class Director {
  private x = 720;
  private y = 450;

  constructor(readonly page: Page, readonly recorder: ScreencastRecorder) {}

  /** Wait a beat so a viewer can read what just changed. */
  async beat(ms = 700): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  /** Re-draw the pointer at its last spot (after a navigation replaced the page). */
  async settlePointer(): Promise<void> {
    await this.page.mouse.move(this.x, this.y);
  }

  /** Glide the pointer to a point. */
  async moveTo(x: number, y: number): Promise<void> {
    const distance = Math.hypot(x - this.x, y - this.y);
    const steps = Math.max(8, Math.min(40, Math.round(distance / 22)));
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      await this.page.mouse.move(this.x + (x - this.x) * eased, this.y + (y - this.y) * eased);
      await this.page.waitForTimeout(12);
    }
    this.x = x;
    this.y = y;
  }

  /** Glide to an element (centre, or an offset inside it). */
  async point(target: Locator, offset?: { x: number; y: number }): Promise<void> {
    await target.waitFor({ state: 'visible', timeout: 30_000 });
    let box = await target.boundingBox();
    const viewport = this.page.viewportSize() ?? { width: 1440, height: 900 };
    // Keep targets clear of the edges, where sticky headers and the Ask composer float over content.
    if (!box || box.y < 110 || box.y + box.height > viewport.height - 190) {
      await target.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
      await this.page.waitForTimeout(650);
      box = await target.boundingBox();
    }
    if (!box) throw new Error(`No bounding box for ${target.toString()}`);
    await this.moveTo(box.x + (offset?.x ?? box.width / 2), box.y + (offset?.y ?? box.height / 2));
  }

  /** Point at, then click, an element. */
  async click(target: Locator, options: { offset?: { x: number; y: number }; after?: number } = {}): Promise<void> {
    await this.point(target, options.offset);
    await this.page.waitForTimeout(220);
    await this.page.mouse.down();
    await this.page.waitForTimeout(70);
    await this.page.mouse.up();
    await this.beat(options.after ?? 650);
  }

  /** Click a field and type into it at a readable pace. */
  async type(target: Locator, text: string, options: { delay?: number; clear?: boolean } = {}): Promise<void> {
    await this.click(target, { after: 250 });
    if (options.clear) await target.fill('');
    await target.pressSequentially(text, { delay: options.delay ?? 38 });
    await this.beat(350);
  }

  async press(key: string, after = 500): Promise<void> {
    await this.page.keyboard.press(key);
    await this.beat(after);
  }

  /**
   * Run a wait (an answer computing, a page loading) and compress it in the
   * final clip to a short beat. The UI is still recorded; it just is not held.
   */
  async fastForward<T>(wait: () => Promise<T>): Promise<T> {
    this.recorder.cutStart();
    try {
      return await wait();
    } finally {
      this.recorder.cutEnd();
    }
  }

  /** Scroll the element under the pointer smoothly. */
  async scroll(deltaY: number, steps = 12): Promise<void> {
    for (let i = 0; i < steps; i += 1) {
      await this.page.mouse.wheel(0, deltaY / steps);
      await this.page.waitForTimeout(25);
    }
    await this.beat(500);
  }

  poster(): void {
    this.recorder.poster();
  }
}
