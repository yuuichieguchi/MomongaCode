import fs from 'node:fs';
import path from 'node:path';
import type { reapMarkerDirectory } from '@momonga/foundation';

export type ReapHold = { readonly markersDir: string; readonly announce: string };

type ReapDirectory = typeof reapMarkerDirectory;

const untilStopped = (stop: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (stop.aborted) {
      resolve();
      return;
    }
    stop.addEventListener('abort', () => resolve(), { once: true });
  });

export const holdReapOfDirectory = (inner: ReapDirectory, hold: ReapHold): ReapDirectory => {
  let held = false;
  return async (options) => {
    if (held || path.resolve(options.dir) !== path.resolve(hold.markersDir)) return inner(options);
    held = true;
    fs.writeFileSync(hold.announce, `${options.dir}\n`);
    await untilStopped(options.signal);
    return inner(options);
  };
};
