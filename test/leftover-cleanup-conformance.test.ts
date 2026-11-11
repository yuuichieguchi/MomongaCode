import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generationLayout, generationMarkerDirectories, momongaPaths, reapDeadGenerations } from '@momonga/foundation';
import type { GenerationReaperResult, MomongaPaths } from '@momonga/foundation';
import { createFakeKernelLock, prepareGenerationForTest, withTempDir } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';

const VERSION = '1.2.3';

const passOf = (paths: MomongaPaths, warnings: string[], lock = createFakeKernelLock({ inheritable: false })): Promise<GenerationReaperResult> =>
  reapDeadGenerations({
    paths,
    lock,
    signal: new AbortController().signal,
    warn: (message) => warnings.push(message),
    reapMarkers: async () => undefined,
  });

const setupHome = (context: CleanupContext) => {
  const home = withTempDir(context, { asHome: true });
  const paths = momongaPaths(home, process.platform, {});
  fs.mkdirSync(paths.markers.root, { recursive: true, mode: 0o700 });
  return { home, paths };
};

describe('LeftoverCleanup.tla, the reaper against the cases of the model (decided variant)', () => {
  it('does not remove a generation whose jobs/ holds an entry (JobsBlockRemoval; the jobsIgnored evidence removes it)', (context) => {
    const { home, paths } = setupHome(context);
    const layout = prepareGenerationForTest(home, 1, VERSION);
    const jobs = path.join(layout.dir, 'jobs');
    fs.mkdirSync(jobs, { mode: 0o700 });
    fs.writeFileSync(path.join(jobs, 'j.out'), 'bytes', { mode: 0o600 });
    const warnings: string[] = [];
    return passOf(paths, warnings).then((result) => {
      expect(result).toEqual({ removed: [], kept: [1], busy: false });
      expect(fs.existsSync(path.join(jobs, 'j.out'))).toBe(true);
      expect(warnings).toEqual([`leftover cleanup kept ${jobs}: ENOTEMPTY`]);
    });
  });

  it('removes the same generation once its jobs/ is empty (the removal waits for the entry, then goes on)', (context) => {
    const { home, paths } = setupHome(context);
    const layout = prepareGenerationForTest(home, 1, VERSION);
    const jobs = path.join(layout.dir, 'jobs');
    fs.mkdirSync(jobs, { mode: 0o700 });
    fs.writeFileSync(path.join(jobs, 'j.out'), 'bytes', { mode: 0o600 });
    const warnings: string[] = [];
    const lock = createFakeKernelLock({ inheritable: false });
    return passOf(paths, warnings, lock)
      .then(() => {
        fs.rmSync(path.join(jobs, 'j.out'));
        return passOf(paths, warnings, lock);
      })
      .then((result) => {
        expect(result).toEqual({ removed: [1], kept: [], busy: false });
        expect(fs.existsSync(layout.dir)).toBe(false);
      });
  });

  it('removes nothing while the starter holds starting.lock of its generation (ClaimDead gate: ~stl)', (context) => {
    const { home, paths } = setupHome(context);
    const layout = prepareGenerationForTest(home, 2, VERSION);
    const lock = createFakeKernelLock({ inheritable: false });
    const starter = lock.claim(layout.startingLock);
    return Promise.resolve(starter).then(async (outcome) => {
      expect(outcome.kind).toBe('claimed');
      await expect(passOf(paths, [], lock)).resolves.toEqual({ removed: [], kept: [], busy: false });
      expect(fs.existsSync(layout.dir)).toBe(true);
    });
  });

  it('keeps a marker whose process may still run: the marker file stays while its sweep chance is unspent (MarkerRemovedDead)', (context) => {
    const { home, paths } = setupHome(context);
    const layout = prepareGenerationForTest(home, 1, VERSION);
    const marker = path.join(generationMarkerDirectories(paths, 1).tools, 'call-1');
    fs.writeFileSync(marker, 'r01000\n', { mode: 0o600 });
    const warnings: string[] = [];
    return passOf(paths, warnings).then((result) => {
      expect(result).toEqual({ removed: [], kept: [1], busy: false });
      expect(fs.existsSync(marker)).toBe(true);
      expect(fs.existsSync(layout.dir)).toBe(true);
      expect(warnings).toHaveLength(1);
    });
  });
});
