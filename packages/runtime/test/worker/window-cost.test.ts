import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { memoryShareFor } from '../../src/worker/memory-share.ts';
import { DEADLINE_MS, createdRun, makeEnv } from './harness.ts';

const PAUSE_BUDGET_MS = 100;
const RUNS = 200;
const LOG_EVENTS = 40;
const LOG_CHARS = 8_000;

const logEvent = (index: number): RunEventPayload => ({
  type: 'tool.completed',
  callId: `call_${index}`,
  status: 'completed',
  output: `line ${index} ${'src/module/file.ts handler 設定ファイル '.repeat(Math.ceil(LOG_CHARS / 30))}`.slice(0, LOG_CHARS),
});

describe('the cost of the adaptive budget window at run start', () => {
  it('reads the last twenty runs within the pause budget in a project with many runs and long logs', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.settings.contextValue = { adaptiveBudget: true };
    for (let index = 0; index < RUNS; index += 1) {
      env.clock.advance(1);
      const run = createdRun(env.store.createRunAndEnqueue(env.session.id, { input: 'Past work', timeoutMs: DEADLINE_MS - env.clock.now(), limits: {}, pins: {}, history: 'fresh' }));
      const claim = env.seed(
        run.id,
        [
          { type: 'run.started', attempt: 1, now: env.clock.now(), pins: { memoryShare: 1 / 4 }, mode: 'default' },
          ...Array.from({ length: LOG_EVENTS }, (_unused, line) => logEvent(line)),
          { type: 'notice', level: 'warning', message: 'dropped', code: 'memories_dropped' },
          { type: 'context.contribution', items: [{ kind: 'memory', id: `past-${index}`, contributed: index % 2 === 0 }] },
        ],
        'hold',
      );
      expect(env.store.transition(claim, ['RUNNING'], 'COMPLETED').kind).toBe('ok');
    }
    const next = env.enqueue('Next', { history: 'fresh' });

    const listStarted = performance.now();
    const listed = env.store.lastTerminalRootRuns(env.session.cwd, 20);
    const listMillis = performance.now() - listStarted;
    const windowStarted = performance.now();
    const share = await memoryShareFor({ store: env.store, settings: env.settings, session: env.session, run: env.run(next.id) });
    const windowMillis = performance.now() - windowStarted;

    console.info(`${RUNS} runs of ${LOG_EVENTS} events of ${LOG_CHARS} characters: lastTerminalRootRuns ${listMillis.toFixed(1)} ms, whole window ${windowMillis.toFixed(1)} ms`);
    expect(listed).toHaveLength(20);
    expect(share).toBe(1 / 4);
    expect(windowMillis).toBeLessThan(PAUSE_BUDGET_MS);
  });
});
