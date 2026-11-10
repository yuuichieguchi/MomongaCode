import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TARGET_NOT_READY, TARGET_PROBING_MESSAGE } from '@momonga/protocol';
import { ProbeInProgressError, acquireProbeLock, createAutoProbe } from '@momonga/gateway';
import type { PreconditionVerdict, ProbeSubject } from '@momonga/gateway';
import { createFakeClock } from '@momonga/testkit';
import { START_MS, makeDir } from './gateway-helpers.ts';
import { until } from './gateway-process-helpers.ts';

type LanternKey = { target: string; lamp: string; wick: string };
type LanternReport = { brightness: number };

const KEY: LanternKey = { target: 'lantern', lamp: 'brass-7', wick: 'cotton' };
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
      state.lockedDuringSave.push(await acquireProbeLock(dir, KEY, KEY.target).then((lock) => (lock.release(), false), (error: unknown) => error instanceof ProbeInProgressError));
      state.saved.push(report);
    },
  };
  return { state, subject };
};

const setup = () => {
  const dir = makeDir();
  const clock = createFakeClock(START_MS);
  const events: Array<{ kind: string; target: string }> = [];
  const autoProbe = createAutoProbe({ dir, clock, retryAfterMs: 120_000, onEvent: (event) => events.push({ kind: event.kind, target: event.target }) });
  const { state, subject } = lantern(dir);
  return { dir, clock, events, autoProbe, state, subject };
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
    expect(await autoProbe.ensure(subject, KEY)).toEqual({ state: 'probing', message: TARGET_PROBING_MESSAGE, retryAfterSeconds: 120 });
    expect(state.measures).toBe(1);
  });

  it('treats a precondition check that outlives its declared bound as no refusal, and probes', async () => {
    const { autoProbe, state, subject } = setup();
    state.verdict = 'never';

    expect(await autoProbe.ensure(subject, KEY)).toMatchObject({ state: 'probing' });
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
