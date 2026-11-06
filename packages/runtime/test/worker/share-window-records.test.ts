import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { memoryShareFor } from '../../src/worker/memory-share.ts';
import { DEADLINE_MS, createdRun, makeEnv } from './harness.ts';

const WINDOW_RUNS = 20;

const plainNotice = (index: number): RunEventPayload => ({ type: 'notice', level: 'warning', message: `retry ${index}: ${'the upstream answered 529 overloaded; '.repeat(20)}`, code: 'attempt_retried' });

const shareWindowWith = async (noticesPerRun: number) => {
  const decoded = { rows: 0, bytes: 0, counting: false };
  const env = await makeEnv({
    mode: 'bypassPermissions',
    onDecode: (rows, bytes) => {
      if (!decoded.counting) return;
      decoded.rows += rows;
      decoded.bytes += bytes;
    },
  });
  env.settings.contextValue = { ...env.settings.contextValue, adaptiveBudget: true, autoCompact: true };
  for (let index = 0; index < WINDOW_RUNS; index += 1) {
    env.clock.advance(1);
    const run = createdRun(env.store.createRunAndEnqueue(env.session.id, { input: 'Past work', timeoutMs: DEADLINE_MS - env.clock.now(), limits: {}, pins: {}, history: 'fresh' }));
    const dropped: RunEventPayload[] = index === WINDOW_RUNS - 1 ? [{ type: 'notice', level: 'warning', message: 'dropped', code: 'memories_dropped' }] : [];
    const claim = env.seed(
      run.id,
      [{ type: 'run.started', attempt: 1, now: env.clock.now(), pins: { memoryShare: 1 / 4 }, mode: 'default' }, { type: 'context.memories_loaded', memories: [{ id: `past-${index}`, status: 'verified' }] }, ...Array.from({ length: noticesPerRun }, (_unused, at) => plainNotice(at)), ...dropped],
      'hold',
    );
    env.scriptContribution(run.id, [{ kind: 'memory', id: `past-${index}`, contributed: true }]);
    expect((await env.store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
  }
  const next = env.enqueue('Next', { history: 'fresh' });
  decoded.counting = true;
  const share = await memoryShareFor({ store: env.store, settings: env.settings, session: env.session, run: env.run(next.id) });
  decoded.counting = false;
  return { share, decoded: { rows: decoded.rows, bytes: decoded.bytes } };
};

describe('the share window reads two small facts per run, written at append (row 8i)', () => {
  it('gives the same share as the journal-reading path: twenty runs, every memory used and one memories_dropped, double the pinned 1/4', async () => {
    const { share } = await shareWindowWith(2);
    expect(share).toBe(1 / 2);
  });

  it('decodes the same rows and bytes on the main thread whether each run has 2 or 40 notices', async () => {
    const few = await shareWindowWith(2);
    const many = await shareWindowWith(40);
    expect(many.share).toBe(few.share);
    expect(many.decoded).toEqual(few.decoded);
  });
});
