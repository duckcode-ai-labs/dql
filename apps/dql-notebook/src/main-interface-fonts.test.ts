import { afterEach, describe, expect, it, vi } from 'vitest';
import { INTERFACE_FONT, INTERFACE_FONT_SAMPLE } from './interface-fonts';

const render = vi.fn();
vi.mock('@duckcodeailabs/dql-ui/styles', () => ({}));
vi.mock('./components/home/ask-run-link', () => ({ resolveAskRunLink: () => Promise.resolve() }));
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render }) }));
vi.mock('./App', () => ({ App: () => null }));

/**
 * The app's entry point (main.tsx) loads every Inter file as it starts and shows the app once they have loaded, so
 * no layout runs against a file that is still loading (interface-fonts.ts says why that can stop the page).
 */
describe('the app\'s entry point and the interface font', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    render.mockReset();
  });

  it('starts loading every Inter file at once and shows the app only after they have loaded', async () => {
    let fontsLoaded: () => void = () => undefined;
    const load = vi.fn(() => new Promise<FontFace[]>((resolve) => { fontsLoaded = () => resolve([]); }));
    vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined, location: { reload: () => undefined } });
    vi.stubGlobal('document', { getElementById: () => ({}), fonts: { load } });

    await import('./main');

    expect(load).toHaveBeenCalledWith(INTERFACE_FONT, INTERFACE_FONT_SAMPLE);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(render, 'the app waits for the font files').not.toHaveBeenCalled();

    fontsLoaded();
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
  });
});
