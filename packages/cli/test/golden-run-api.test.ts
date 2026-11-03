import { describe, expect, it } from 'vitest';
import type { ContextChargeView, ReflectionJobView, RunReflectionView } from '@momonga/protocol';
import { goldenRunApi } from '../src/client/golden-run-api.ts';

const job = (state: ReflectionJobView['state'], attempts = state === 'pending' ? 0 : 1): ReflectionJobView => ({ runId: 'run-1', state, attempts, reason: null, dropped: [], updatedAt: 1 });

const charge = (id: number): ContextChargeView => ({ id, purpose: 'reflection', runId: 'run-1', project: '/w', model: 'm', inputTokens: 10, outputTokens: 2, totalTokens: 12, createdAt: 1 });

type Bounds = { pendingBoundMs: number; attemptBoundMs: number; pollMs: number };

const apiOver = (views: RunReflectionView[], waits: number[], bounds: Bounds = { pendingBoundMs: 2000, attemptBoundMs: 5000, pollMs: 1000 }, options: { signal?: AbortSignal; stepMs?: number; onWait?: () => void } = {}) => {
  let reads = 0;
  let clock = 0;
  const client = {
    runReflection: async (): Promise<RunReflectionView> => {
      const view = views[Math.min(reads, views.length - 1)] as RunReflectionView;
      reads += 1;
      return view;
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

  it('sends no request at all when the signal has already fired', async () => {
    const controller = new AbortController();
    controller.abort(new Error('interrupted'));
    const { api, reads } = apiOver([{ job: job('pending'), charges: [] }], [], undefined, { signal: controller.signal });

    await expect(api.reflectionOf('run-1')).rejects.toThrow('interrupted');
    expect(reads()).toBe(0);
  });
});
