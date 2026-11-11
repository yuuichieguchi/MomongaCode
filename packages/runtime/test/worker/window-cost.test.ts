import { describe, expect, it } from 'vitest';
import { CONTRIBUTION_WINDOW_RUNS } from '@momonga/memory';
import type { RunEventPayload } from '@momonga/protocol';
import { memoryShareFor } from '../../src/worker/memory-share.ts';
import { DEADLINE_MS, createdRun, makeEnv } from './harness.ts';
import { LARGE_RUN_SETUP_TEST_TIMEOUT_MS } from './pause-budget.ts';

const RUNS = 60;
const LOG_SIZES = [10, 40] as const;
const LOG_CHARS = 8_000;
const EVENTS_READ_PER_RUN = 3;

const logEvent = (index: number): RunEventPayload => ({
  type: 'tool.completed',
  callId: `call_${index}`,
  status: 'completed',
  output: `line ${index} ${'src/module/file.ts handler 設定ファイル '.repeat(Math.ceil(LOG_CHARS / 30))}`.slice(0, LOG_CHARS),
});

type Counts = { rows: number; bytes: number };

const windowCounts = async (logEvents: number): Promise<Counts> => {
  const counting = { on: false, rows: 0, bytes: 0 };
  const env = await makeEnv({
    mode: 'bypassPermissions',
    onDecode: (rows, bytes) => {
      if (!counting.on) return;
      counting.rows += rows;
      counting.bytes += bytes;
    },
  });
  env.settings.contextValue = { ...env.settings.contextValue, adaptiveBudget: true, autoCompact: true };
  for (let index = 0; index < RUNS; index += 1) {
    env.clock.advance(1);
    const run = await createdRun(await env.store.createRunAndEnqueue(env.session.id, { input: 'Past work', timeoutMs: DEADLINE_MS - env.clock.now(), limits: {}, pins: {}, history: 'fresh' }));
    const claim = await env.seed(
      run.id,
      [
        { type: 'run.started', attempt: 1, now: env.clock.now(), pins: { memoryShare: 1 / 4 }, mode: 'manual' },
        { type: 'context.memories_loaded', memories: [{ id: `past-${index}`, status: 'verified' }] },
        ...Array.from({ length: logEvents }, (_unused, line) => logEvent(line)),
        { type: 'notice', level: 'warning', message: 'dropped', code: 'memories_dropped' },
      ],
      'hold',
    );
    env.scriptContribution(run.id, [{ kind: 'memory', id: `past-${index}`, contributed: index % 2 === 0 }]);
    expect((await env.store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
  }
  const next = await env.enqueue('Next', { history: 'fresh' });

  counting.on = true;
  const listed = env.store.lastTerminalRootRuns(env.session.cwd, CONTRIBUTION_WINDOW_RUNS);
  const share = await memoryShareFor({ signal: new AbortController().signal, store: env.store, settings: env.settings, session: env.session, run: env.run(next.id) });
  counting.on = false;

  expect(listed).toHaveLength(CONTRIBUTION_WINDOW_RUNS);
  expect(share).toBe(1 / 4);
  return { rows: counting.rows, bytes: counting.bytes };
};

describe('the loop share of the adaptive budget window at run start, as counts (row 8h, 8i; design section 7)', () => {
  it('decodes three small events for each of the last twenty runs, the same rows and bytes whether the runs hold 10 or 40 long log events', async () => {
    const counts: Counts[] = [];
    for (const logEvents of LOG_SIZES) counts.push(await windowCounts(logEvents));

    expect(counts.map((count) => count.rows)).toEqual(LOG_SIZES.map(() => CONTRIBUTION_WINDOW_RUNS * EVENTS_READ_PER_RUN));
    expect(new Set(counts.map((count) => count.bytes)).size).toBe(1);
    expect(counts[0]?.bytes ?? 0).toBeLessThan(LOG_CHARS);
  }, LARGE_RUN_SETUP_TEST_TIMEOUT_MS);
});
