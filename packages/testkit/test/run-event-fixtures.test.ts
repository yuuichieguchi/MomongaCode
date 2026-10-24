import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import { RECORDED_RUNS, createFakeClock, materializeEvents } from '@momonga/testkit';

describe('createFakeClock', () => {
  it('starts at the given time and moves only when told', () => {
    const clock = createFakeClock(1000);
    expect(clock.now()).toBe(1000);
    clock.advance(250);
    expect(clock.now()).toBe(1250);
    clock.set(10);
    expect(clock.now()).toBe(10);
  });
});

describe('recorded run fixtures', () => {
  it.each(RECORDED_RUNS.map((run) => [run.name, run] as const))('%s materializes contiguous seq and monotone step', (_name, run) => {
    const events = materializeEvents(run.payloads, { runId: 'r', sessionId: 's' });
    expect(events.map((event) => event.seq)).toEqual(run.payloads.map((_payload, index) => index + 1));
    expect(events.every((event) => event.runId === 'r' && event.sessionId === 's')).toBe(true);
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index]!.step).toBeGreaterThanOrEqual(events[index - 1]!.step);
    }
    expect(events[0]!.type).toBe('user.message');
  });

  it('assigns each event the step of the latest model step seen so far', () => {
    const run = RECORDED_RUNS[1]!;
    const steps = materializeEvents(run.payloads).map((event) => [event.type, event.step]);
    expect(steps).toEqual([
      ['user.message', 0],
      ['run.status', 0],
      ['run.started', 0],
      ['instructions.loaded', 0],
      ['model.requested', 1],
      ['model.responded', 1],
      ['tool.call', 1],
      ['tool.started', 1],
      ['tool.updated', 1],
      ['tool.completed', 1],
      ['model.requested', 2],
      ['model.responded', 2],
      ['run.status', 2],
    ]);
  });

  it('covers context.compaction_rejected, with and without step and attempt, after a context.compacted', () => {
    const runs = RECORDED_RUNS.filter((run) => run.payloads.some((payload) => payload.type === 'context.compaction_rejected'));
    expect(runs.length).toBeGreaterThan(0);
    const rejections = runs.flatMap((run) => run.payloads.filter((payload) => payload.type === 'context.compaction_rejected'));
    expect(rejections.some((payload) => 'step' in payload && 'attempt' in payload)).toBe(true);
    expect(rejections.some((payload) => !('step' in payload) && !('attempt' in payload))).toBe(true);
    for (const run of runs) {
      const types = run.payloads.map((payload) => payload.type);
      expect(types.indexOf('context.compacted')).toBeGreaterThanOrEqual(0);
      expect(types.indexOf('context.compacted')).toBeLessThan(types.indexOf('context.compaction_rejected'));
    }
  });

  it('covers context.inherited right after the task and before run.started, with a digest over its content', () => {
    const runs = RECORDED_RUNS.filter((run) => run.payloads.some((payload) => payload.type === 'context.inherited'));
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      const types = run.payloads.map((payload) => payload.type);
      expect(types.filter((type) => type === 'context.inherited')).toHaveLength(1);
      expect(types.indexOf('context.inherited')).toBeGreaterThan(types.indexOf('user.message'));
      const started = types.indexOf('run.started');
      if (started >= 0) expect(types.indexOf('context.inherited')).toBeLessThan(started);
      const inherited = run.payloads.find((payload) => payload.type === 'context.inherited') as unknown as {
        history: unknown[];
        nextItemSeq: number;
        summary?: unknown;
        evicted: string[];
        mode?: string;
        digest: string;
      };
      expect(inherited.digest).toBe(
        sha256Hex(
          canonicalJson({
            history: inherited.history,
            nextItemSeq: inherited.nextItemSeq,
            summary: inherited.summary ?? null,
            evicted: inherited.evicted,
            mode: inherited.mode ?? null,
          }),
        ),
      );
    }
  });
});
