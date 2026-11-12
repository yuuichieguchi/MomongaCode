import { createRedactor } from '@momonga/foundation';
import { describe, expect, it } from 'vitest';
import { TARGET_PROBING, measuringOfWire } from '@momonga/protocol';
import { ProbeInProgressError, acquireProbeLock, createAutoProbe, probingOf, recordProbe, targetProbingError } from '@momonga/gateway';
import type { MeasurementProgress, ProbeSubject } from '@momonga/gateway';
import { createFakeClock, createFakeTimers, testKernelLock } from '@momonga/testkit';
import { START_MS, makeDir } from './gateway-helpers.ts';
import { until } from './gateway-process-helpers.ts';

type GlassKey = { target: string; pane: string };
type GlassReport = { clear: boolean };

const KEY: GlassKey = { target: 'glass', pane: 'north' };
const CAP_MS = 120_000;
const UNKNOWN = { fields: ['toolCalling'], declaration: 'declare toolCalling for the model "glass" in its settings' } as const;

const setup = () => {
  const dir = makeDir();
  const clock = createFakeClock(START_MS);
  const timers = createFakeTimers(clock);
  const progress: MeasurementProgress[] = [];
  const pending: Array<{ resolve: (report: GlassReport) => void; signal: AbortSignal }> = [];
  const subject: ProbeSubject<GlassKey, GlassReport> = {
    target: KEY.target,
    unknown: UNKNOWN,
    readKey: async () => KEY,
    precondition: { boundMs: 50, check: async () => ({ kind: 'met' }) },
    measure: ({ signal, progress: reported }) => {
      progress.push(reported);
      return new Promise((resolve) => pending.push({ resolve, signal }));
    },
    save: async () => undefined,
  };
  const autoProbe = createAutoProbe({ redactor: createRedactor({ credentials: [] }), lock: testKernelLock(), dir, clock, timers, retryAfterMs: CAP_MS, onEvent: () => undefined });
  return { dir, clock, timers, autoProbe, subject, progress, pending };
};

describe('the measuring state: what is measured, the step, the elapsed time and the declaration that makes it unnecessary', () => {
  it('answers at once, before any step reported, with the unknown fields, no step, no elapsed time and the declaration', async () => {
    const { autoProbe, subject, pending } = setup();

    const probing = await autoProbe.ensure(subject, KEY);

    expect(pending).toHaveLength(1);
    expect(probing).toMatchObject({ state: 'probing', retryAfterSeconds: CAP_MS / 1000, measuring: { fields: ['toolCalling'], step: null, elapsedSeconds: 0, declaration: UNKNOWN.declaration } });
  });

  it('names the step the measurement reports and the time since it started, and the retry-after is the bound of that step', async () => {
    const { autoProbe, subject, progress, clock } = setup();
    await autoProbe.ensure(subject, KEY);
    await until(() => progress.length === 1, 'the measurement started');

    progress[0]?.step('plain answer', 30_000);
    clock.advance(10_000);
    const probing = await autoProbe.ensure(subject, KEY);

    expect(probing).toMatchObject({ retryAfterSeconds: 30, measuring: { step: 'plain answer', elapsedSeconds: 10 } });
  });

  it('carries the measuring state in the error body on the wire, and reads it back from there', async () => {
    const { autoProbe, subject } = setup();
    const probing = await autoProbe.ensure(subject, KEY);

    const error = targetProbingError(probing);

    expect(error.body.code).toBe(TARGET_PROBING);
    expect(error.body.measuring).toEqual({ fields: ['toolCalling'], step: null, elapsed_seconds: 0, declaration: UNKNOWN.declaration });
    expect(measuringOfWire(error.body.measuring)).toEqual(probing.measuring);
    expect(probingOf(error)).toEqual(probing);
  });
});

describe('the wait for the lock of a measured key', () => {
  it('ends with the key in progress at its deadline while another holder keeps the lock, and never waits past it', async () => {
    const { dir, timers, subject } = setup();
    const held = await acquireProbeLock(dir, KEY, KEY.target, testKernelLock());
    const finished = { subject: { ...subject, measure: async () => ({ clear: true }) } };
    try {
      const recording = recordProbe(finished.subject, dir, testKernelLock(), timers, new AbortController().signal, CAP_MS);
      const outcome = recording.then(
        () => 'recorded',
        (error: unknown) => error,
      );
      await until(() => timers.pending().length > 0, 'the lock wait is armed on the timer port');
      await timers.advanceAsync(CAP_MS);

      expect(await outcome).toBeInstanceOf(ProbeInProgressError);
    } finally {
      held.release();
    }
  });

  it('ends at the signal of the caller', async () => {
    const { dir, timers, subject } = setup();
    const held = await acquireProbeLock(dir, KEY, KEY.target, testKernelLock());
    const stop = new AbortController();
    try {
      const recording = recordProbe({ ...subject, measure: async () => ({ clear: true }) }, dir, testKernelLock(), timers, stop.signal, CAP_MS).then(
        () => 'recorded',
        () => 'ended',
      );
      await until(() => timers.pending().length > 0, 'the lock wait is armed on the timer port');
      stop.abort();

      expect(await recording).toBe('ended');
    } finally {
      held.release();
    }
  });
});
