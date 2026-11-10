import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STOP_VALUES, generationMarkerDirectories, momongaPaths } from '@momonga/foundation';
import type { GenerationReaperOptions, MarkerKind, ReapMarkerDirectoryOptions } from '@momonga/foundation';
import { createFakeClock, createFakeKernelLock, createFakeTimers, fakeReapTiming, prepareGenerationForTest, withTempDir } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { DAEMON_MARKER_KILL_GRACE_MS } from '../src/constants.ts';
import { DEAD_GENERATION_MARKER_KILL_GRACE_MS, createReaperPass, entryReaperPass } from '../src/reaper-pass.ts';
import type { ReaperPassOptions } from '../src/reaper-pass.ts';
import { captureLog } from './fixtures/p3-harness.ts';

const MANAGED_STOP_GRACE_MS = 7300;

const setup = (context: CleanupContext, overrides: Partial<ReaperPassOptions> = {}) => {
  const home = fs.realpathSync(withTempDir(context));
  const paths = momongaPaths(home, process.platform, {});
  fs.mkdirSync(paths.markers.root, { recursive: true, mode: 0o700 });
  const clock = createFakeClock(0);
  const timers = createFakeTimers(clock);
  const log = captureLog(clock);
  const reaps: ReapMarkerDirectoryOptions[] = [];
  const options: ReaperPassOptions = {
    paths,
    lock: createFakeKernelLock({ inheritable: false }),
    logger: log.logger,
    timers,
    reapTiming: fakeReapTiming(clock, timers),
    orphanGraceMs: 10_000,
    orphanReapGraceMs: DAEMON_MARKER_KILL_GRACE_MS,
    orphanPollMs: 250,
    managedServerStopGraceMs: () => MANAGED_STOP_GRACE_MS,
    markerPorts: {
      findHolders: async () => [],
      reapMarkerDirectory: async (request) => {
        reaps.push(request);
        return { reaped: 0, kept: 0 };
      },
    },
    ...overrides,
  };
  return { home, paths, log, reaps, options };
};

describe('the reaper pass of the serving supervisor (20.61, 20.62)', () => {
  it('hands the reaper the home paths, the lock mechanism and the signal of the pass', async (context) => {
    const seen: GenerationReaperOptions[] = [];
    const s = setup(context, {
      reapDeadGenerations: async (options) => {
        seen.push(options);
        return { removed: [], kept: [], busy: false };
      },
    });
    const lifetime = new AbortController();
    await createReaperPass(s.options)({ signal: lifetime.signal });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.paths).toBe(s.options.paths);
    expect(seen[0]?.lock).toBe(s.options.lock);
    expect(seen[0]?.signal).toBe(lifetime.signal);
  });

  it('reaps each marker kind of a dead generation with its label and grace, spending the sweep chance', async (context) => {
    const s = setup(context);
    prepareGenerationForTest(s.home, 1, '1.2.3');
    const markers = generationMarkerDirectories(s.paths, 1);
    fs.writeFileSync(path.join(markers.daemons, 'runtime-old'), '', { mode: 0o600 });
    await createReaperPass(s.options)({ signal: new AbortController().signal });
    const expected: Array<{ kind: MarkerKind; label: string; killGraceMs: number }> = [
      { kind: 'daemons', label: 'daemon', killGraceMs: DAEMON_MARKER_KILL_GRACE_MS },
      { kind: 'mcp', label: 'mcp', killGraceMs: DEAD_GENERATION_MARKER_KILL_GRACE_MS },
      { kind: 'tools', label: 'tool', killGraceMs: DEAD_GENERATION_MARKER_KILL_GRACE_MS },
      { kind: 'targets', label: 'managed server', killGraceMs: MANAGED_STOP_GRACE_MS },
    ];
    expect(s.reaps.map(({ dir, label, killGraceMs, occasion }) => ({ dir, label, killGraceMs, occasion }))).toEqual(
      expected.map(({ kind, label, killGraceMs }) => ({ dir: markers[kind], label, killGraceMs, occasion: 'sweep' })),
    );
    expect(DEAD_GENERATION_MARKER_KILL_GRACE_MS).toBe(2000);
  });

  it('removes a dead generation and leaves a live one, through the real reaper', async (context) => {
    const s = setup(context);
    const dead = prepareGenerationForTest(s.home, 1, '1.2.3');
    const live = prepareGenerationForTest(s.home, 2, '1.2.3');
    const lock = createFakeKernelLock({ inheritable: false });
    lock.holdExternally(live.locks.supervisor, process.pid);
    await createReaperPass({ ...s.options, lock })({ signal: new AbortController().signal });
    expect(fs.existsSync(dead.dir)).toBe(false);
    expect(fs.existsSync(dead.markers)).toBe(false);
    expect(fs.existsSync(live.dir)).toBe(true);
  });

  it('writes the warning of a kept entry once in the life of the supervisor (20.62)', async (context) => {
    const s = setup(context);
    const layout = prepareGenerationForTest(s.home, 1, '1.2.3');
    const unknown = path.join(layout.dir, 'future-thing');
    fs.writeFileSync(unknown, '');
    const pass = createReaperPass(s.options);
    for (let tick = 0; tick < 3; tick += 1) await pass({ signal: new AbortController().signal });
    expect(s.log.withMsg('orphans.warning').map((line) => line['detail'])).toEqual([`leftover cleanup kept ${unknown}: this version does not know the entry`]);
    expect(fs.existsSync(layout.dir)).toBe(true);
  });

  it('builds the production pass from the entry values: 2000 ms for daemon markers and the user\'s managed server stop grace', async (context) => {
    const s = setup(context);
    prepareGenerationForTest(s.home, 1, '1.2.3');
    const markers = generationMarkerDirectories(s.paths, 1);
    fs.writeFileSync(path.join(markers.daemons, 'gateway-old'), '', { mode: 0o600 });
    const pass = entryReaperPass(
      { lockMechanism: s.options.lock, reapTiming: s.options.reapTiming, ...(s.options.markerPorts === undefined ? {} : { markerPorts: s.options.markerPorts }) },
      {
        home: s.home,
        clock: createFakeClock(0),
        timers: s.options.timers,
        logger: s.log.logger,
        stopValues: { read: () => ({ ...DEFAULT_STOP_VALUES, managedServerStopGraceMs: MANAGED_STOP_GRACE_MS }), remember: () => undefined },
      },
    );
    await pass({ signal: new AbortController().signal });
    expect(s.reaps.map(({ label, killGraceMs }) => ({ label, killGraceMs }))).toEqual([
      { label: 'daemon', killGraceMs: DAEMON_MARKER_KILL_GRACE_MS },
      { label: 'mcp', killGraceMs: DEAD_GENERATION_MARKER_KILL_GRACE_MS },
      { label: 'tool', killGraceMs: DEAD_GENERATION_MARKER_KILL_GRACE_MS },
      { label: 'managed server', killGraceMs: MANAGED_STOP_GRACE_MS },
    ]);
  });
});
