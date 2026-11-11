import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STOP_VALUES, MAXIMUM_STOP_VALUES, generationMarkerDirectories, momongaPaths, runtimeMaxCloseMs, writeStopRecord } from '@momonga/foundation';
import type { GenerationReaperOptions, MarkerKind, ReapMarkerDirectoryOptions, StopValues } from '@momonga/foundation';
import { createFakeClock, createFakeKernelLock, createFakeTimers, fakeReapTiming, prepareGenerationForTest, withTempDir } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { DAEMON_MARKER_KILL_GRACE_MS } from '../src/constants.ts';
import { DEAD_GENERATION_MARKER_KILL_GRACE_MS, createReaperPass, entryReaperPass } from '../src/reaper-pass.ts';
import type { ReaperPassOptions } from '../src/reaper-pass.ts';
import { captureLog, createRealWorkScope, pumpUntil, settledFlag } from './fixtures/p3-harness.ts';

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
  return { home, paths, log, reaps, options, clock, timers };
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

describe('the wait of the reaper pass for a dead generation takes the values of that generation\'s stop (design-close-grace-settings 3.4 and 4.3, update design 14.15 and 20.16)', () => {
  const PREDECESSOR: StopValues = { closeGraceMs: 1, managedServerStopGraceMs: 2, drainTimeoutMs: 7000, mcpCloseGraceMs: 40 };
  const HELD_FOREVER = 999_999;
  const ORPHAN_POLL_MS = 250;

  const daemonReapTime = async (context: CleanupContext, record: (stopRecord: string) => Promise<void>): Promise<number> => {
    const daemonReapAt: number[] = [];
    const s = setup(context, { orphanGraceMs: 10 * runtimeMaxCloseMs(MAXIMUM_STOP_VALUES), orphanPollMs: ORPHAN_POLL_MS });
    const options: ReaperPassOptions = {
      ...s.options,
      markerPorts: {
        findHolders: async () => [HELD_FOREVER],
        reapMarkerDirectory: async (request) => {
          if (request.label === 'daemon') daemonReapAt.push(s.clock.now());
          return { reaped: 0, kept: 0 };
        },
      },
    };
    const layout = prepareGenerationForTest(s.home, 1, '1.2.3');
    fs.writeFileSync(path.join(generationMarkerDirectories(s.paths, 1).daemons, 'runtime-old'), '', { mode: 0o600 });
    await record(layout.stopRecord);
    const realWork = createRealWorkScope();
    const pass = settledFlag(realWork.run(() => createReaperPass(options)({ signal: new AbortController().signal })));
    await pumpUntil(s.timers, () => pass.settled(), { realWork, maxMs: 2 * runtimeMaxCloseMs(MAXIMUM_STOP_VALUES), description: 'the reaper pass to settle' });
    expect(daemonReapAt).toHaveLength(1);
    return daemonReapAt[0] as number;
  };

  it('waits the runtime close bound of the values the dead generation recorded when its stop began', async (context) => {
    const reapedAt = await daemonReapTime(context, (stopRecord) => writeStopRecord(stopRecord, 1, PREDECESSOR));
    expect(runtimeMaxCloseMs(PREDECESSOR)).toBe(7000 + 6 * 40 + 28_125);
    expect(reapedAt).toBeGreaterThanOrEqual(runtimeMaxCloseMs(PREDECESSOR));
    expect(reapedAt).toBeLessThanOrEqual(runtimeMaxCloseMs(PREDECESSOR) + ORPHAN_POLL_MS);
  });

  it('waits the runtime close bound of the allowed maxima when the dead generation left no record', async (context) => {
    const reapedAt = await daemonReapTime(context, async () => undefined);
    expect(runtimeMaxCloseMs(MAXIMUM_STOP_VALUES)).toBe(508_125);
    expect(reapedAt).toBeGreaterThanOrEqual(508_125);
    expect(reapedAt).toBeLessThanOrEqual(508_125 + ORPHAN_POLL_MS);
  });

  it('waits the bound of the allowed maxima when the record is invalid or names another generation', async (context) => {
    const reapedAt = await daemonReapTime(context, async (stopRecord) => fs.writeFileSync(stopRecord, `${JSON.stringify({ generation: 2, values: PREDECESSOR })}\n`, { mode: 0o600 }));
    expect(reapedAt).toBeGreaterThanOrEqual(508_125);
  });

  it('removes the stop record with the directory of the dead generation, as one known entry of it', async (context) => {
    const s = setup(context);
    const layout = prepareGenerationForTest(s.home, 1, '1.2.3');
    await writeStopRecord(layout.stopRecord, 1, PREDECESSOR);
    await createReaperPass(s.options)({ signal: new AbortController().signal });
    expect(s.log.withMsg('orphans.warning')).toEqual([]);
    expect(fs.existsSync(layout.dir)).toBe(false);
  });
});
