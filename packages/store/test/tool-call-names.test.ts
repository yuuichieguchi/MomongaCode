import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { callEvent, enqueue, harness, mustClaim, newSession } from './helpers.ts';
import type { Harness } from './helpers.ts';

const named = (callId: string, name: string): RunEventPayload => ({ ...callEvent(callId), name });

const runWith = async (h: Harness, payloads: readonly RunEventPayload[]): Promise<string> => {
  const run = await enqueue(h.store, newSession(h.store).id);
  const claim = mustClaim(h.store, `w-${run.id}`);
  expect(h.store.append(claim, [{ type: 'run.started', attempt: 1, now: h.clock.now(), pins: {} }, ...payloads]).kind).toBe('ok');
  expect((await h.store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
  return run.id;
};

describe('toolCallNames', () => {
  it('returns the distinct names of the tool calls of one run, sorted', async () => {
    const h = harness();
    const run = await runWith(h, [named('call_1', 'Read'), named('call_2', 'Bash'), named('call_3', 'Read')]);

    expect(h.store.toolCallNames(run)).toEqual(['Bash', 'Read']);
  });

  it('returns no names for a run that called no tool', async () => {
    const h = harness();
    const run = await runWith(h, []);

    expect(h.store.toolCallNames(run)).toEqual([]);
  });

  it('reads only the calls of the run it is given', async () => {
    const h = harness();
    const first = await runWith(h, [named('call_1', 'Glob')]);
    const second = await runWith(h, [named('call_2', 'Grep')]);

    expect(h.store.toolCallNames(first)).toEqual(['Glob']);
    expect(h.store.toolCallNames(second)).toEqual(['Grep']);
  });
});
