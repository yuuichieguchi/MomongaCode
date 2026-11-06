import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { ContextChargeView, ReflectionJobView, RunReflectionView } from '@momonga/protocol';
import { goldenRunApi } from '../src/client/golden-run-api.ts';

const job = (state: ReflectionJobView['state'], attempts = state === 'pending' ? 0 : 1): ReflectionJobView => ({ runId: 'run-1', state, attempts, reason: null, dropped: [], updatedAt: 1 });

const charge = (id: number): ContextChargeView => ({ id, purpose: 'reflection', runId: 'run-1', project: '/w', model: 'm', inputTokens: 10, outputTokens: 2, totalTokens: 12, createdAt: 1 });

type Bounds = { pendingBoundMs: number; attemptBoundMs: number; pollMs: number };

type View = Omit<RunReflectionView, 'queuedAhead'> & { queuedAhead?: number };

const apiOver = (views: View[], waits: number[], bounds: Bounds = { pendingBoundMs: 2000, attemptBoundMs: 5000, pollMs: 1000 }, options: { signal?: AbortSignal; stepMs?: number; onWait?: () => void } = {}) => {
  let reads = 0;
  let clock = 0;
  const client = {
    runReflection: async (): Promise<RunReflectionView> => {
      const view = views[Math.min(reads, views.length - 1)] as View;
      reads += 1;
      return { queuedAhead: 0, ...view };
    },
  };
  const api = goldenRunApi(client as never, undefined, {
    ...bounds,
    now: () => clock,
    wait: async (ms) => {
      waits.push(ms);
      clock += options.stepMs ?? ms;
      options.onWait?.();
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return { api, reads: () => reads };
};

describe('the reflection of a run in the golden run api', () => {
  it('waits while the job goes pending, then running, then done, and returns the charge of the finished job', async () => {
    const waits: number[] = [];
    const { api, reads } = apiOver(
      [
        { job: job('pending'), charges: [] },
        { job: job('running'), charges: [] },
        { job: job('done'), charges: [charge(1)] },
      ],
      waits,
    );

    expect(await api.reflectionOf('run-1')).toEqual({ state: 'done', charges: [charge(1)] });
    expect(reads()).toBe(3);
    expect(waits).toEqual([1000, 1000]);
  });

  it('returns at once for a run that has no job, or a job in a terminal state', async () => {
    const waits: number[] = [];
    expect(await apiOver([{ job: null, charges: [] }], waits).api.reflectionOf('run-1')).toEqual({ state: 'none' });
    expect(await apiOver([{ job: job('failed'), charges: [charge(1), charge(2)] }], waits).api.reflectionOf('run-1')).toEqual({ state: 'failed', charges: [charge(1), charge(2)] });
    expect(waits).toEqual([]);
  });

  it('gives up on a job that never starts after the pickup bound, saying the runtime was busy', async () => {
    const waits: number[] = [];
    const { api } = apiOver([{ job: job('pending'), charges: [] }], waits);

    const answer = await api.reflectionOf('run-1');

    expect(answer.state).toBe('pending');
    expect(answer.reason).toBe('the runtime was busy with other runs, so the reflection did not start');
    expect(waits).toEqual([1000, 1000]);
  });

  it('extends the pickup bound by the attempts bound of every job queued ahead, read at each poll, so a held reflector does not make the case unsettled', async () => {
    const waits: number[] = [];
    const held = (queuedAhead: number): View => ({ job: job('pending'), charges: [], queuedAhead });
    const { api } = apiOver([held(1), held(1), held(1), held(1), held(0), { job: job('running'), charges: [] }, { job: job('done'), charges: [charge(1)] }], waits);

    expect(await api.reflectionOf('run-1')).toEqual({ state: 'done', charges: [charge(1)] });
    expect(waits).toHaveLength(6);
  });

  it('still gives up with the busy reason once the queue ahead and the pickup interval are spent', async () => {
    const waits: number[] = [];
    const { api } = apiOver([{ job: job('pending'), charges: [], queuedAhead: 1 }], waits);

    const answer = await api.reflectionOf('run-1');

    expect(answer.reason).toBe('the runtime was busy with other runs, so the reflection did not start');
    expect(waits).toHaveLength(7);
  });

  it('applies the attempt bound, measured from the first sign of an attempt, once the job has started', async () => {
    const waits: number[] = [];
    const { api } = apiOver([{ job: job('pending'), charges: [] }, { job: job('running'), charges: [] }], waits);

    const answer = await api.reflectionOf('run-1');

    expect(answer.state).toBe('running');
    expect(answer.reason).toMatch(/5000 ms/);
    expect(waits).toEqual([1000, 1000, 1000, 1000, 1000, 1000]);
  });

  it('measures elapsed time with the clock, not as a sum of the waits', async () => {
    const waits: number[] = [];
    const { api } = apiOver([{ job: job('running'), charges: [] }], waits, { pendingBoundMs: 2000, attemptBoundMs: 5000, pollMs: 1000 }, { stepMs: 2600 });

    await api.reflectionOf('run-1');

    expect(waits).toEqual([1000, 1000]);
  });

  it('stops with the abort error when the signal fires during the wait, and sends no further request', async () => {
    const controller = new AbortController();
    const waits: number[] = [];
    const { api, reads } = apiOver([{ job: job('pending'), charges: [] }], waits, undefined, { signal: controller.signal, onWait: () => controller.abort(new Error('interrupted')) });

    await expect(api.reflectionOf('run-1')).rejects.toThrow('interrupted');

    expect(reads()).toBe(1);
    expect(waits).toEqual([1000]);
  });

  it('leaves no abort listener behind: at most one while it waits, none after many polls and after an abort', async () => {
    const controller = new AbortController();
    const seen: number[] = [];
    const pending = Array.from({ length: 40 }, () => ({ job: job('pending'), charges: [], queuedAhead: 100 }));
    const { api } = apiOver([...pending, { job: job('done'), charges: [] }], [], { pendingBoundMs: 1_000_000, attemptBoundMs: 5000, pollMs: 1000 }, {
      signal: controller.signal,
      onWait: () => void seen.push(getEventListeners(controller.signal, 'abort').length),
    });

    await api.reflectionOf('run-1');
    await api.reflectionOf('run-1');

    expect(Math.max(...seen)).toBeLessThanOrEqual(1);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('sends no request at all when the signal has already fired', async () => {
    const controller = new AbortController();
    controller.abort(new Error('interrupted'));
    const { api, reads } = apiOver([{ job: job('pending'), charges: [] }], [], undefined, { signal: controller.signal });

    await expect(api.reflectionOf('run-1')).rejects.toThrow('interrupted');
    expect(reads()).toBe(0);
  });
});

describe('what answered a run in the golden run api', () => {
  it('takes it from the runtime, which derived it from the pins of the run', async () => {
    const answered = [{ target: 'opus', adapter: 'anthropic', upstreamModel: 'claude-opus', answers: 'model' as const }];
    const asked: string[] = [];
    const client = {
      runAnsweredBy: async (runId: string) => {
        asked.push(runId);
        return { answeredBy: answered };
      },
    };
    const api = goldenRunApi(client as never, undefined, { pendingBoundMs: 1, attemptBoundMs: 1, pollMs: 1, now: () => 0, wait: async () => undefined });
    expect(await api.answeredBy('run-9')).toEqual(answered);
    expect(asked).toEqual(['run-9']);
  });
});
