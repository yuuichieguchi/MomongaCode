import { existsSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOG_KEEP, nodeFileSystem, rotatedLogPath, rotatedLogsPurge } from '@momonga/foundation';
import { NEVER_CANCELLED } from '@momonga/testkit';
import { harness } from './helpers.ts';

const DAY_MS = 86_400_000;
const PERIOD_MS = 30 * DAY_MS;

const writtenAt = (file: string, atMs: number): string => {
  writeFileSync(file, 'line\n');
  utimesSync(file, new Date(atMs), new Date(atMs));
  return file;
};

describe('the log files under the one retention sweep', () => {
  it('removes a rotated log file older than the period and keeps the current file and the newer rotated files', async () => {
    const { store, clock, dir } = harness();
    const nowMs = clock.now();
    const oldMs = nowMs - PERIOD_MS - DAY_MS;
    const current = writtenAt(path.join(dir, 'runtime.log'), oldMs);
    const oldRotated = writtenAt(rotatedLogPath(current, LOG_KEEP), oldMs);
    const newRotated = writtenAt(rotatedLogPath(current, 1), nowMs - DAY_MS);
    const otherOld = writtenAt(rotatedLogPath(path.join(dir, 'supervisor.log'), 2), oldMs);

    await store.retention.sweep({ periodMs: PERIOD_MS, purges: [rotatedLogsPurge(nodeFileSystem, [current, path.join(dir, 'supervisor.log')])] }, NEVER_CANCELLED);

    expect(existsSync(oldRotated)).toBe(false);
    expect(existsSync(otherOld)).toBe(false);
    expect(existsSync(current)).toBe(true);
    expect(existsSync(newRotated)).toBe(true);
  });

  it('stops before the next file once the sweep is cancelled', async () => {
    const { dir } = harness();
    const current = path.join(dir, 'gateway.log');
    const old = writtenAt(rotatedLogPath(current, 1), 0);
    const controller = new AbortController();
    controller.abort(new Error('the runtime is stopping'));
    await expect(rotatedLogsPurge(nodeFileSystem, [current])([], Date.now(), controller.signal)).rejects.toThrow('the runtime is stopping');
    expect(existsSync(old)).toBe(true);
  });
});
