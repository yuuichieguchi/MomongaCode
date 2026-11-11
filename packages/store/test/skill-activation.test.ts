import { describe, expect, it } from 'vitest';
import type { RunEvent, RunEventPayload, RunState } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import type { Claim, RuntimeStore } from '@momonga/store';
import { START_MS, TIMEOUT_MS, harness, mustClaim, newSession } from './helpers.ts';
import { foldedRunState, roundTripped } from './run-state-codec.ts';
import { assistantItem } from './inherit-fixtures.ts';
import { TEST_FENCE } from '@momonga/testkit';

const IDS = { runId: 'run-1', sessionId: 'sess-1' };
const USAGE = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };

const foldAll = (payloads: readonly RunEventPayload[]): RunState =>
  payloads.reduce<RunState>(
    (state, payload, index) =>
      foldRunState(state, { ...payload, id: index + 1, ...IDS, seq: index + 1, step: 0, leaseToken: 1, createdAt: START_MS } as RunEvent),
    initialRunState({ ...IDS, fence: TEST_FENCE }),
  );

const createRun = async (store: RuntimeStore, sessionId: string, skill?: { name: string; content: string }) => {
  const result = await store.createRunAndEnqueue(sessionId, {
    input: 'use the skill',
    timeoutMs: TIMEOUT_MS,
    limits: {},
    pins: {},
    ...(skill === undefined ? {} : { skill }),
  });
  if (result.kind !== 'created') throw new Error(`expected a created run, got ${result.kind}`);
  return result.run;
};

const finish = async (store: RuntimeStore, claim: Claim): Promise<void> => {
  const answer: RunEventPayload[] = [
    { type: 'run.started', attempt: 1, now: START_MS, pins: { model: 'fm' }, mode: 'manual' },
    { type: 'model.requested', step: 1, attempt: 1, digest: 'd1', body: { tool_choice: 'auto' } },
    { type: 'model.responded', step: 1, attempt: 1, response: { status: 'completed', output: [assistantItem('m1', 'done')], usage: USAGE } },
  ];
  expect(store.append(claim, answer).kind).toBe('ok');
  expect((await store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
};

describe('skill.activated in the fold', () => {
  it('starts without activated skills', () => {
    expect(initialRunState({ ...IDS, fence: TEST_FENCE }).activatedSkills).toEqual([]);
  });

  it('records each skill once and keeps the first content', () => {
    const state = foldAll([
      { type: 'skill.activated', name: 'a', content: 'first' },
      { type: 'skill.activated', name: 'b', content: 'other' },
      { type: 'skill.activated', name: 'a', content: 'second' },
    ]);
    expect(state.activatedSkills).toEqual([
      { name: 'a', content: 'first', seq: 1 },
      { name: 'b', content: 'other', seq: 2 },
    ]);
  });

  it('does not touch the conversation history', () => {
    const state = foldAll([{ type: 'user.message', text: 'hi' }, { type: 'skill.activated', name: 'a', content: 'body' }]);
    expect(state.history).toHaveLength(1);
    expect(state.nextItemSeq).toBe(2);
  });
});

describe('explicit skill activation at run creation', () => {
  it('appends skill.activated right after the user message', async () => {
    const { store } = harness();
    const session = newSession(store);
    const run = await createRun(store, session.id, { name: 'pdf', content: '<skill_content name="pdf">x</skill_content>' });
    expect(store.readRunEvents(run.id, 0, 10).map((event) => event.type)).toEqual(['user.message', 'skill.activated']);
    const state = await foldedRunState(store, run.id);
    expect(state.activatedSkills).toEqual([{ name: 'pdf', content: '<skill_content name="pdf">x</skill_content>', seq: 2 }]);
  });

  it('appends nothing extra without a skill', async () => {
    const { store } = harness();
    const run = await createRun(store, newSession(store).id);
    expect(store.readRunEvents(run.id, 0, 10).map((event) => event.type)).toEqual(['user.message']);
  });
});

describe('skill inheritance across runs of a session', () => {
  it('carries the activated skills into the next run and keeps the next run explicit activation', async () => {
    const { store } = harness({ leaseMs: 10 * TIMEOUT_MS, inheritance: true });
    const session = newSession(store);
    await createRun(store, session.id, { name: 'pdf', content: 'pdf body' });
    await finish(store, mustClaim(store, 'w1'));

    const second = await createRun(store, session.id, { name: 'review', content: 'review body' });
    const claim = mustClaim(store, 'w1');
    expect((await store.inheritContext(claim, { mode: 'manual' })).kind).not.toBe('conflict');

    const events = store.readRunEvents(second.id, 0, 100);
    const inherited = events.find((event) => event.type === 'context.inherited');
    expect(inherited).toMatchObject({ activatedSkills: [{ name: 'pdf', content: 'pdf body' }] });
    const state = events.reduce(foldRunState, initialRunState({ runId: second.id, sessionId: second.sessionId, fence: TEST_FENCE }));
    expect(state.activatedSkills).toEqual([
      { name: 'pdf', content: 'pdf body', seq: 3 },
      { name: 'review', content: 'review body', seq: 2 },
    ]);
  });

  it('keeps one copy when the next run activates a skill that was inherited', async () => {
    const { store } = harness({ leaseMs: 10 * TIMEOUT_MS, inheritance: true });
    const session = newSession(store);
    await createRun(store, session.id, { name: 'pdf', content: 'pdf body' });
    await finish(store, mustClaim(store, 'w1'));
    const second = await createRun(store, session.id, { name: 'pdf', content: 'changed body' });
    await store.inheritContext(mustClaim(store, 'w1'), { mode: 'manual' });
    const state = store.readRunEvents(second.id, 0, 100).reduce(foldRunState, initialRunState({ runId: second.id, sessionId: second.sessionId, fence: TEST_FENCE }));
    expect(state.activatedSkills).toEqual([{ name: 'pdf', content: 'pdf body', seq: 3 }]);
  });

  it('does not add the field when no skill was activated', async () => {
    const { store } = harness({ leaseMs: 10 * TIMEOUT_MS, inheritance: true });
    const session = newSession(store);
    await createRun(store, session.id);
    await finish(store, mustClaim(store, 'w1'));
    const second = await createRun(store, session.id);
    await store.inheritContext(mustClaim(store, 'w1'), { mode: 'manual' });
    const inherited = store.readRunEvents(second.id, 0, 100).find((event) => event.type === 'context.inherited');
    expect(inherited).toBeDefined();
    expect(inherited).not.toHaveProperty('activatedSkills');
  });
});

describe('skill snapshots', () => {
  it('round-trips activated skills through a snapshot', async () => {
    const { store } = harness();
    const run = await createRun(store, newSession(store).id, { name: 'pdf', content: 'pdf body' });
    const events = store.readRunEvents(run.id, 0, 100);
    const state = events.reduce(foldRunState, initialRunState({ runId: run.id, sessionId: run.sessionId, fence: TEST_FENCE }));
    expect(roundTripped(state)?.activatedSkills).toEqual([{ name: 'pdf', content: 'pdf body', seq: 2 }]);
  });
});
