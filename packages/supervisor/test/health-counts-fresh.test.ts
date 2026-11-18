import { describe, expect, it, vi } from 'vitest';
import type { SupervisorHealth } from '@momonga/protocol';
import { HEALTH_CHILD_COUNTS_BOUND_MS, SUPERVISOR_RESPONSE_BOUND_MS } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, firstGeneration } from '@momonga/testkit';
import type { GenerationCounts } from '../src/child-counts.ts';
import { httpOver, pumpUntil, settledFlag, startHarness } from './fixtures/p3-harness.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

describe('the work counts in the supervisor health', () => {
  it('are read from the children when the health is asked, not taken from the last poll', async (context) => {
    let current: GenerationCounts = { steps: 1, jobs: 0, interrupts: [{ kind: 'run', id: 'run-1' }] };
    const h = await startHarness(context, { overrides: { childCounts: async (role) => (role === 'runtime' ? current : { calls: 0 }) } });
    await h.waitForState('runtime', 'ready');
    await h.waitForState('gateway', 'ready');
    const socket = firstGeneration(h.paths).sockets.supervisor;

    const busy = JSON.parse((await httpOver(context, socket, 'GET', '/v1/health')).text) as SupervisorHealth;
    expect({ steps: busy.steps, jobs: busy.jobs, interrupts: busy.interrupts }).toEqual({ steps: 1, jobs: 0, interrupts: [{ kind: 'run', id: 'run-1' }] });

    current = { steps: 0, jobs: 0, interrupts: [] };
    const idle = JSON.parse((await httpOver(context, socket, 'GET', '/v1/health')).text) as SupervisorHealth;
    expect({ steps: idle.steps, jobs: idle.jobs, interrupts: idle.interrupts }).toEqual({ steps: 0, jobs: 0, interrupts: [] });
  });

  it('answers within its own bound when the runtime never answers, and says the runtime counts are not known instead of a figure', async (context) => {
    const h = await startHarness(context, { overrides: { childCounts: (role) => (role === 'runtime' ? new Promise<GenerationCounts>(() => undefined) : Promise.resolve({ calls: 2 })) } });
    await h.waitForState('runtime', 'ready');
    await h.waitForState('gateway', 'ready');
    const startedAt = h.clock.now();

    const asked = settledFlag(h.realWork.run(() => httpOver(context, firstGeneration(h.paths).sockets.supervisor, 'GET', '/v1/health')));
    await pumpUntil(h.timers, () => asked.settled(), { realWork: h.realWork, maxMs: SUPERVISOR_RESPONSE_BOUND_MS, description: 'the health answer' });
    const health = JSON.parse((await asked.promise).text) as SupervisorHealth;

    expect(h.clock.now() - startedAt).toBeLessThanOrEqual(HEALTH_CHILD_COUNTS_BOUND_MS);
    expect(HEALTH_CHILD_COUNTS_BOUND_MS).toBeLessThan(SUPERVISOR_RESPONSE_BOUND_MS);
    expect({ countsNotKnown: health.countsNotKnown, steps: health.steps, jobs: health.jobs, interrupts: health.interrupts, calls: health.calls }).toEqual({
      countsNotKnown: ['runtime'],
      steps: undefined,
      jobs: undefined,
      interrupts: undefined,
      calls: 2,
    });
  });
});
