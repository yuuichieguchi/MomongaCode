import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_STOP_VALUES, MAXIMUM_STOP_VALUES, daemonStopBoundMs, generationLayout, momongaPaths, nodeGenerationReaperFiles, readStopRecord, reapDeadGenerations, writeStopRecord } from '@momonga/foundation';
import type { GenerationReaperFiles } from '@momonga/foundation';
import { orphanPhaseOneBoundMs } from '@momonga/supervisor';
import { createTempDir, prepareGenerationForTest, removeTempDir, testKernelLock } from '@momonga/testkit';
import { STOP_WAIT_WHEN_UNKNOWN_MS } from '../src/daemon/ensure-daemon.ts';

const VERSION = '1.2.3';

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await removeTempDir(home);
});

const removes = (target: string, file: string): boolean => file === target || file.startsWith(`${target}${path.sep}`);

const UNBOUNDED_GRACE = { orphanGraceMs: Number.POSITIVE_INFINITY, orphanPollMs: 0 };

describe('T-L2-15 (14.15): the stop record goes only with its directory, and a reader that then finds none waits the longest stop', () => {
  it('keeps the record readable through the marker reap and the member claims, removes it with the directory, and a reader that meets ENOENT bounds its wait by the maximum stop values, the values of STOP_WAIT_WHEN_UNKNOWN_MS', async () => {
    const home = createTempDir({ asHome: true });
    homes.push(home);
    const paths = momongaPaths(home, process.platform, {});
    fs.mkdirSync(paths.markers.root, { recursive: true, mode: 0o700 });
    prepareGenerationForTest(home, 1, VERSION);
    const layout = generationLayout(home, 1);
    const lock = testKernelLock();
    await writeStopRecord(layout.stopRecord, 1, DEFAULT_STOP_VALUES, lock);
    const log: string[] = [];
    const recorded = (name: keyof GenerationReaperFiles) => async (target: string) => {
      log.push(`${name} ${target}`);
      return (nodeGenerationReaperFiles[name] as (file: string) => Promise<unknown>)(target);
    };
    const files = {
      readdir: recorded('readdir'),
      markerFiles: recorded('markerFiles'),
      mkdir: recorded('mkdir'),
      unlink: recorded('unlink'),
      rmdir: recorded('rmdir'),
      removeTree: recorded('removeTree'),
    } as GenerationReaperFiles;
    const readAtReap: unknown[] = [];
    const result = await reapDeadGenerations({
      paths,
      lock,
      signal: new AbortController().signal,
      warn: () => undefined,
      files,
      reapMarkers: async () => {
        log.push('reap');
        readAtReap.push(await readStopRecord(layout.stopRecord));
      },
    });
    expect(result).toEqual({ removed: [1], kept: [], busy: false });
    expect(readAtReap.length).toBeGreaterThan(0);
    expect(readAtReap.every((values) => JSON.stringify(values) === JSON.stringify(DEFAULT_STOP_VALUES))).toBe(true);
    const removals = log.flatMap((line, index) => (/^(unlink|rmdir|removeTree) /.test(line) && removes(line.slice(line.indexOf(' ') + 1), layout.stopRecord) ? [index] : []));
    const lastReap = log.lastIndexOf('reap');
    expect(removals.length).toBeGreaterThan(0);
    expect(removals.every((index) => index > lastReap)).toBe(true);
    expect(fs.existsSync(layout.dir)).toBe(false);
    const after = await readStopRecord(layout.stopRecord);
    expect(after).toBeUndefined();
    expect(orphanPhaseOneBoundMs({ ...UNBOUNDED_GRACE, predecessorStopValues: after })).toBe(orphanPhaseOneBoundMs({ ...UNBOUNDED_GRACE, predecessorStopValues: MAXIMUM_STOP_VALUES }));
    expect(STOP_WAIT_WHEN_UNKNOWN_MS).toBe(daemonStopBoundMs(MAXIMUM_STOP_VALUES));
  });
});
