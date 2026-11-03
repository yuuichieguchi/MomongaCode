import { describe, expect, it } from 'vitest';
import type { ContextChargeView, ReflectionJobView, RunReflectionView } from '@momonga/protocol';
import { goldenRunApi } from '../src/client/golden-run-api.ts';

const job = (state: ReflectionJobView['state']): ReflectionJobView => ({ runId: 'run-1', state, attempts: 1, reason: null, dropped: [], updatedAt: 1 });

const charge = (id: number): ContextChargeView => ({ id, purpose: 'reflection', runId: 'run-1', project: '/w', model: 'm', inputTokens: 10, outputTokens: 2, totalTokens: 12, createdAt: 1 });

const apiOver = (views: RunReflectionView[], waits: number[], bound = { boundMs: 5000, pollMs: 1000 }) => {
  let reads = 0;
  const client = {
    runReflection: async (): Promise<RunReflectionView> => {
      const view = views[Math.min(reads, views.length - 1)] as RunReflectionView;
      reads += 1;
      return view;
    },
  };
  const api = goldenRunApi(client as never, undefined, { ...bound, wait: async (ms) => void waits.push(ms) });
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

  it('gives up when the bound of the job has passed and says why, leaving the run unsettled', async () => {
    const waits: number[] = [];
    const { api } = apiOver([{ job: job('pending'), charges: [] }], waits, { boundMs: 3000, pollMs: 1000 });

    const answer = await api.reflectionOf('run-1');

    expect(answer.state).toBe('pending');
    expect(answer.reason).toMatch(/3000 ms/);
    expect(waits).toEqual([1000, 1000, 1000]);
  });
});
