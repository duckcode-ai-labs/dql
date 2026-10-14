import { describe, expect, it } from 'vitest';
import { createNotebookSaveQueue } from './notebook-save-queue';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('notebook save queue (F8: the indicator must leave "Saving…" once the file is written)', () => {
  it('reports the lane idle as soon as the awaited save resolves', async () => {
    const writes: string[] = [];
    const queue = createNotebookSaveQueue(async (_path, content) => { writes.push(content); });
    await queue.enqueue('notebooks/a.dqlnb', 'v1');
    // The header clears "Saving…" only when nothing is pending at this exact point.
    expect(queue.pending('notebooks/a.dqlnb')).toBe(false);
    expect(writes).toEqual(['v1']);
  });

  it('stays pending while a newer save is queued, then settles idle', async () => {
    const first = deferred();
    const writes: string[] = [];
    const queue = createNotebookSaveQueue(async (_path, content) => {
      writes.push(content);
      if (content === 'v1') await first.promise;
    });
    const one = queue.enqueue('nb.dqlnb', 'v1');
    const two = queue.enqueue('nb.dqlnb', 'v2');
    const three = queue.enqueue('nb.dqlnb', 'v3');
    expect(queue.pending('nb.dqlnb')).toBe(true);
    first.resolve();
    await one;
    // v2/v3 collapsed into one follow-up save that has not finished yet.
    expect(queue.pending('nb.dqlnb')).toBe(true);
    await Promise.all([two, three]);
    expect(queue.pending('nb.dqlnb')).toBe(false);
    expect(writes).toEqual(['v1', 'v3']);
  });

  it('releases the lane after a failed save so the next save can run', async () => {
    let fail = true;
    const queue = createNotebookSaveQueue(async () => {
      if (fail) throw new Error('disk full');
    });
    await expect(queue.enqueue('nb.dqlnb', 'v1')).rejects.toThrow('disk full');
    expect(queue.pending('nb.dqlnb')).toBe(false);
    fail = false;
    await queue.enqueue('nb.dqlnb', 'v2');
    expect(queue.pending('nb.dqlnb')).toBe(false);
  });

  it('keeps lanes for different files independent', async () => {
    const gate = deferred();
    const queue = createNotebookSaveQueue(async (path) => { if (path === 'slow.dqlnb') await gate.promise; });
    const slow = queue.enqueue('slow.dqlnb', 'x');
    await queue.enqueue('fast.dqlnb', 'y');
    expect(queue.pending('fast.dqlnb')).toBe(false);
    expect(queue.pending('slow.dqlnb')).toBe(true);
    gate.resolve();
    await slow;
    expect(queue.pending('slow.dqlnb')).toBe(false);
  });
});
