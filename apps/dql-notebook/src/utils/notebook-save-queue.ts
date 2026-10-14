/**
 * One save lane per notebook path: saves to the same file never overlap, and a
 * burst of edits while a save is in flight collapses into one follow-up save of
 * the latest content.
 *
 * The lane is released *before* the waiters of its last batch are resolved. A
 * caller that awaits its save and then asks `notebookSavePending(path)` must see
 * `false` once nothing else is queued; otherwise the "Saving…" indicator never
 * clears (the release used to happen in a `.finally()` that ran after every
 * waiter had already checked, so the header stayed at "Saving…" until reload).
 */

interface NotebookSaveWaiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface NotebookSaveLane {
  running: boolean;
  pending?: { content: string; waiters: NotebookSaveWaiter[] };
}

export type NotebookSaveWriter = (path: string, content: string) => Promise<unknown>;

export function createNotebookSaveQueue(write: NotebookSaveWriter) {
  const lanes = new Map<string, NotebookSaveLane>();

  const pending = (path: string): boolean => {
    const lane = lanes.get(path);
    return Boolean(lane?.running || lane?.pending);
  };

  const enqueue = (path: string, content: string): Promise<void> => {
    let lane = lanes.get(path);
    if (!lane) {
      lane = { running: false };
      lanes.set(path, lane);
    }
    const activeLane = lane;
    const promise = new Promise<void>((resolve, reject) => {
      if (activeLane.pending) {
        activeLane.pending.content = content;
        activeLane.pending.waiters.push({ resolve, reject });
      } else {
        activeLane.pending = { content, waiters: [{ resolve, reject }] };
      }
    });
    if (!activeLane.running) {
      activeLane.running = true;
      void (async () => {
        while (activeLane.pending) {
          const batch = activeLane.pending;
          activeLane.pending = undefined;
          let failure: { error: unknown } | undefined;
          try {
            await write(path, batch.content);
          } catch (error) {
            failure = { error };
          }
          if (!activeLane.pending) {
            // Nothing queued behind this batch: release the lane first, so the
            // waiters below observe an idle lane when they resume.
            activeLane.running = false;
            if (lanes.get(path) === activeLane) lanes.delete(path);
          }
          for (const waiter of batch.waiters) {
            if (failure) waiter.reject(failure.error);
            else waiter.resolve();
          }
        }
      })();
    }
    return promise;
  };

  return { enqueue, pending };
}
