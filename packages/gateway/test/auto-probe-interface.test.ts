import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TARGET_NOT_READY, TARGET_PROBING_MESSAGE } from '@momonga/protocol';
import { ProbeInProgressError, acquireProbeLock, createAutoProbe } from '@momonga/gateway';
import type { PreconditionVerdict, ProbeSubject } from '@momonga/gateway';
import { createFakeClock, createFakeTimers, hostTimers, testKernelLock } from '@momonga/testkit';
import { START_MS, makeDir } from './gateway-helpers.ts';
import { until } from './gateway-process-helpers.ts';

type LanternKey = { target: string; lamp: string; wick: string };
type LanternReport = { brightness: number };

const KEY: LanternKey = { target: 'lantern', lamp: 'brass-7', wick: 'cotton' };
const OTHER_KEY: LanternKey = { target: 'lantern', lamp: 'copper-2', wick: 'cotton' };
const LANTERN_REMEDY = 'trim the wick of the lantern';

const lantern = (dir: string) => {
  const state = {
    verdict: { kind: 'met' } as PreconditionVerdict | 'never',
    measures: 0,
    saved: [] as LanternReport[],
    lockedDuringSave: [] as boolean[],
    pending: [] as Array<{ resolve: (report: LanternReport) => void; reject: (error: Error) => void; signal: AbortSignal }>,
  };
  const subject: ProbeSubject<LanternKey, LanternReport> = {
    target: KEY.target,
    unknown: { fields: ['toolCalling'], declaration: 'declare toolCalling' },
    readKey: async () => KEY,
    precondition: {
      boundMs: 50,
      check: (signal) =>
        state.verdict === 'never'
          ? new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
          : Promise.resolve(state.verdict),
    },
    measure: ({ signal }) => {
      state.measures += 1;
      return new Promise((resolve, reject) => state.pending.push({ resolve, reject, signal }));
    },
    save: async (_key, report) => {
      state.lockedDuringSave.push(await acquireProbeLock(dir, KEY, KEY.target, testKernelLock()).then((lock) => (lock.release(), false), (error: unknown) => error instanceof ProbeInProgressError));
      state.saved.push(report);
    },
  };
  return { state, subject };
};

const setup = () => {
  const dir = makeDir();
  const clock = createFakeClock(START_MS);
  const timers = createFakeTimers(clock);
  const events: Array<{ kind: string; target: string }> = [];
  const autoProbe = createAutoProbe({ lock: testKernelLock(), dir, clock, timers, retryAfterMs: 120_000, onEvent: (event) => events.push({ kind: event.kind, target: event.target }) });
  const { state, subject } = lantern(dir);
  return { dir, clock, timers, events, autoProbe, state, subject };
};

describe('the automatic probe through its one interface, with an adapter no other test uses', () => {
  it('answers a definite refusal 412 target_not_ready with the adapter remedy, starts nothing, remembers nothing, and probes once the precondition is met', async () => {
    const { autoProbe, state, subject } = setup();
    state.verdict = { kind: 'refused', message: 'the lantern has no wick', detail: 'wick length 0 mm', remedy: LANTERN_REMEDY };

    const refusal = await autoProbe.ensure(subject, KEY).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ status: 412, body: { code: TARGET_NOT_READY } });
    expect((refusal as Error).message).toContain(LANTERN_REMEDY);
    expect(state.measures).toBe(0);

    state.verdict = { kind: 'met' };
    expect(await autoProbe.ensure(subject, KEY)).toEqual({ state: 'probing', message: TARGET_PROBING_MESSAGE, retryAfterSeconds: 120, measuring: { fields: ['toolCalling'], step: null, elapsedSeconds: 0, declaration: 'declare toolCalling' } });
    expect(state.measures).toBe(1);
  });

  it('treats a precondition check that outlives its declared bound as no refusal, and probes', async () => {
    const { autoProbe, state, subject, timers } = setup();
    state.verdict = 'never';

    const ensured = autoProbe.ensure(subject, KEY);
    await until(() => timers.pending().some((timer) => timer.delayMs === 50), 'the bound of the precondition is armed on the timer port');
    timers.advance(50);
    expect(await ensured).toMatchObject({ state: 'probing' });
    expect(state.measures).toBe(1);
  });

  it('starts no probe of a key for one Retry-After interval after a started probe failed, answering 503 target_probe_failed with the cause and the remaining interval', async () => {
    const { autoProbe, clock, events, state, subject } = setup();
    await autoProbe.ensure(subject, KEY);
    state.pending[0]?.reject(new Error('the lantern went out'));
    await until(() => events.some((event) => event.kind === 'failed'), 'the failure is reported');

    clock.advance(45_000);
    const failed = await autoProbe.ensure(subject, KEY).catch((error: unknown) => error);
    expect(failed).toMatchObject({
      status: 503,
      body: { type: 'server_error', code: 'target_probe_failed', message: 'measuring this model failed: the lantern went out' },
      headers: { 'retry-after': '75' },
    });
    expect(state.measures).toBe(1);

    clock.advance(75_000);
    await autoProbe.ensure(subject, KEY);
    expect(state.measures).toBe(2);
  });

  it('saves the measurement while it holds the lock of the key, and reports success', async () => {
    const { autoProbe, events, state, subject } = setup();
    await autoProbe.ensure(subject, KEY);

    state.pending[0]?.resolve({ brightness: 3 });
    await until(() => state.saved.length === 1, 'the measurement is saved');

    expect(state.lockedDuringSave).toEqual([true]);
    expect(events).toEqual([]);
  });

  it('counts its open flights: a key that is starting or in progress counts once, and none is left after close (design-update 18.1.4)', async () => {
    const { autoProbe, state, subject, timers } = setup();
    const other = { ...subject, readKey: async () => OTHER_KEY };
    expect(autoProbe.openFlights()).toBe(0);

    state.verdict = 'never';
    const starting = autoProbe.ensure(subject, KEY);
    expect(autoProbe.openFlights()).toBe(0);
    await until(() => timers.pending().some((timer) => timer.delayMs === 50), 'the bound of the precondition is armed on the timer port');
    timers.advance(50);
    await starting;
    expect(autoProbe.openFlights()).toBe(1);

    state.verdict = { kind: 'met' };
    await autoProbe.ensure(other, OTHER_KEY);
    expect(autoProbe.openFlights()).toBe(2);
    await autoProbe.ensure(subject, KEY);
    expect(autoProbe.openFlights()).toBe(2);

    await autoProbe.close();
    expect(autoProbe.openFlights()).toBe(0);
  });

  it('starts no flight while its gateway is retiring', async () => {
    const dir = makeDir();
    const { state, subject } = lantern(dir);
    const autoProbe = createAutoProbe({ lock: testKernelLock(), dir, clock: createFakeClock(START_MS), timers: hostTimers, retryAfterMs: 120_000, onEvent: () => undefined, role: { current: () => 'retiring' } });

    expect(await autoProbe.ensure(subject, KEY)).toEqual({ state: 'probing', message: TARGET_PROBING_MESSAGE, retryAfterSeconds: 120, measuring: { fields: ['toolCalling'], step: null, elapsedSeconds: 0, declaration: 'declare toolCalling' } });

    expect(state.measures).toBe(0);
    expect(autoProbe.openFlights()).toBe(0);
  });

  it('runs the flights of two gateways for one key in parallel, and each writes the record while it holds the key lock (design-update 18.3, 20.56)', async () => {
    const dir = makeDir();
    const first = lantern(dir);
    const second = lantern(dir);
    const probes = [first, second].map(() => createAutoProbe({ lock: testKernelLock(), dir, clock: createFakeClock(START_MS), timers: hostTimers, retryAfterMs: 120_000, onEvent: () => undefined }));

    await probes[0]?.ensure(first.subject, KEY);
    await probes[1]?.ensure(second.subject, KEY);
    expect([first.state.measures, second.state.measures]).toEqual([1, 1]);
    expect(probes.map((probe) => probe.openFlights())).toEqual([1, 1]);

    first.state.pending[0]?.resolve({ brightness: 3 });
    second.state.pending[0]?.resolve({ brightness: 3 });
    await until(() => first.state.saved.length === 1 && second.state.saved.length === 1, 'both measurements are saved');

    expect([first.state.lockedDuringSave, second.state.lockedDuringSave]).toEqual([[true], [true]]);
    expect(probes.map((probe) => probe.openFlights())).toEqual([0, 0]);
  });

  it('reports a probe ended by close as stopped, not failed, and leaves no backoff behind', async () => {
    const { autoProbe, events, state, subject, dir } = setup();
    await autoProbe.ensure(subject, KEY);

    await autoProbe.close();

    expect(state.pending[0]?.signal.aborted).toBe(true);
    expect(events).toEqual([{ kind: 'stopped', target: 'lantern' }]);
    expect(fs.readdirSync(dir).filter((file) => file.endsWith('.json'))).toEqual([]);
    expect(path.isAbsolute(dir)).toBe(true);
  });
});
