import { describe, expect, it } from 'vitest';
import { createFakeClock } from '@momonga/testkit';
import { EVERY_ROLE_LOOP_NAMES, SERVING_LOOP_NAMES, SERVING_TASK_NAMES, createServingTasks } from '../../src/process/serving-tasks.ts';
import type { ServingTaskOutcome } from '../../src/process/serving-tasks.ts';
import { START_MS } from './helpers.ts';

const HOUR_MS = 3_600_000;

const setup = (outcomes: { prune?: ServingTaskOutcome[] } = {}) => {
  const clock = createFakeClock(START_MS);
  const ran: string[] = [];
  const reported: unknown[] = [];
  const loops = { started: 0, stopped: 0 };
  const pruneOutcomes = [...(outcomes.prune ?? [])];
  const tasks = createServingTasks({
    clock,
    report: (error) => reported.push(error),
    loops: [
      {
        start: () => {
          loops.started += 1;
          return {
            stop: () => {
              loops.stopped += 1;
            },
          };
        },
      },
    ],
    tasks: [
      {
        name: 'idempotency-purge',
        intervalMs: HOUR_MS,
        run: () => {
          ran.push('idempotency-purge');
          return 'done';
        },
      },
      {
        name: 'fidelity-prune',
        intervalMs: HOUR_MS,
        run: () => {
          ran.push('fidelity-prune');
          return pruneOutcomes.shift() ?? 'done';
        },
      },
      {
        name: 'tool-markers',
        intervalMs: 30_000,
        lastRanAt: START_MS,
        run: async (): Promise<ServingTaskOutcome> => {
          ran.push('tool-markers');
          return 'done';
        },
      },
    ],
  });
  return { clock, ran, reported, loops, tasks };
};

describe('the serving tick (17.2, 20.48)', () => {
  it('names the serving-only tasks and loops and the every-role loops as data', () => {
    expect(SERVING_TASK_NAMES).toEqual(['idempotency-purge', 'session-scratch', 'spawn-scratch', 'call-locks', 'fidelity-prune', 'tool-markers', 'job-reconcile', 'placeholder-recovery']);
    expect(SERVING_LOOP_NAMES).toEqual(['approval-sweeper', 'terminal-sweeper', 'search-sweeper', 'memory-sweeper', 'facts-sweeper', 'body-purge']);
    expect(EVERY_ROLE_LOOP_NAMES).toEqual(['role-tick', 'store-identity', 'session-state-eviction', 'data-version-poll']);
  });

  it.each(['starting', 'retiring'] as const)('runs no task and starts no loop while %s', async (role) => {
    const t = setup();

    await t.tasks.tick(role);
    t.clock.advance(2 * HOUR_MS);
    await t.tasks.tick(role);

    expect(t.ran).toEqual([]);
    expect(t.loops).toEqual({ started: 0, stopped: 0 });
  });

  it('runs every task once at the moment the role becomes serving, except one whose start-up run counts, and starts the loops once', async () => {
    const t = setup();

    await t.tasks.tick('starting');
    await t.tasks.tick('serving');
    await t.tasks.tick('serving');

    expect(t.ran).toEqual(['idempotency-purge', 'fidelity-prune']);
    expect(t.loops).toEqual({ started: 1, stopped: 0 });
  });

  it('runs a task again only when its own interval has elapsed', async () => {
    const t = setup();
    await t.tasks.tick('serving');
    t.ran.length = 0;

    t.clock.advance(29_999);
    await t.tasks.tick('serving');
    expect(t.ran).toEqual([]);
    t.clock.advance(1);
    await t.tasks.tick('serving');
    expect(t.ran).toEqual(['tool-markers']);
    t.clock.advance(HOUR_MS - 30_000);
    await t.tasks.tick('serving');
    expect(t.ran).toEqual(['tool-markers', 'idempotency-purge', 'fidelity-prune', 'tool-markers']);
  });

  it('runs a task that answered again at the next tick, one batch per tick, until it answers done', async () => {
    const t = setup({ prune: ['again', 'again', 'done'] });

    await t.tasks.tick('serving');
    await t.tasks.tick('serving');
    await t.tasks.tick('serving');
    await t.tasks.tick('serving');

    expect(t.ran.filter((name) => name === 'fidelity-prune')).toHaveLength(3);
    expect(t.ran.filter((name) => name === 'idempotency-purge')).toHaveLength(1);
  });

  it('stops the loops and runs no task once the role is retiring, and close stops them too', async () => {
    const t = setup();
    await t.tasks.tick('serving');
    t.ran.length = 0;

    t.clock.advance(2 * HOUR_MS);
    await t.tasks.tick('retiring');
    await t.tasks.close();

    expect(t.ran).toEqual([]);
    expect(t.loops).toEqual({ started: 1, stopped: 1 });
  });

  it('reports a task that throws, keeps its interval and goes on with the next task', async () => {
    const clock = createFakeClock(START_MS);
    const failure = new Error('the purge failed');
    const ran: string[] = [];
    const reported: unknown[] = [];
    const tasks = createServingTasks({
      clock,
      report: (error) => reported.push(error),
      loops: [],
      tasks: [
        {
          name: 'idempotency-purge',
          intervalMs: HOUR_MS,
          run: () => {
            ran.push('idempotency-purge');
            throw failure;
          },
        },
        {
          name: 'session-scratch',
          intervalMs: HOUR_MS,
          run: () => {
            ran.push('session-scratch');
            return 'done';
          },
        },
      ],
    });

    await tasks.tick('serving');
    await tasks.tick('serving');

    expect(reported).toEqual([failure]);
    expect(ran).toEqual(['idempotency-purge', 'session-scratch']);
  });
});
