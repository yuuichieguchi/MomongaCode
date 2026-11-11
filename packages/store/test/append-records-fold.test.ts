import { describe, expect, it } from 'vitest';
import type { RunEvent, RunEventPayload, RunState } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import { fixtureCompactionItem, materializeEvents } from '@momonga/testkit';
import { enqueue, harness, mustClaim, newSession, openStoreAt, rawDb } from './helpers.ts';
import { encodedRunState, foldedRunState } from './run-state-codec.ts';
import { TEST_FENCE } from '@momonga/testkit';
import type { RuntimeStore } from '../src/types.ts';

const STOP_FEEDBACK = '[Stop hook feedback]\n';
const USAGE = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };

const hook = (hookEvent: 'SessionStart' | 'UserPromptSubmit' | 'Stop'): RunEventPayload => ({ type: 'hook.completed', hookEvent, command: `echo ${hookEvent}`, outcome: 'success', durationMs: 1 });

const requested = (step: number): RunEventPayload => ({ type: 'model.requested', step, attempt: 1, digest: `d${step}`, body: { tool_choice: 'auto' } });

const answered = (step: number, text: string): RunEventPayload => ({
  type: 'model.responded',
  step,
  attempt: 1,
  response: { status: 'completed', output: [{ type: 'message', id: `m${step}`, role: 'assistant', content: [{ type: 'output_text', text }] }], usage: USAGE },
});

const calling = (step: number, callIds: readonly string[]): RunEventPayload => ({
  type: 'model.responded',
  step,
  attempt: 1,
  response: {
    status: 'completed',
    output: callIds.map((callId) => ({ type: 'function_call', id: `fc-${callId}`, call_id: callId, name: 'Write', arguments: '{}' })),
    usage: USAGE,
  },
});

const call = (callId: string): RunEventPayload => ({ type: 'tool.call', callId, providerCallId: callId, name: 'Write', kind: 'edit', title: `Write ${callId}`, rawInput: { id: callId } });

const completed = (callId: string, status: 'completed' | 'failed'): RunEventPayload => ({ type: 'tool.completed', callId, status, output: `output of ${callId}` });

const JOURNAL: RunEventPayload[] = [
  { type: 'user.message', text: 'do the task' },
  { type: 'run.started', attempt: 1, now: 1, pins: { model: 'fm' } },
  hook('SessionStart'),
  hook('UserPromptSubmit'),
  requested(1),
  calling(1, ['c1', 'c2']),
  call('c1'),
  call('c2'),
  completed('c1', 'completed'),
  completed('c2', 'failed'),
  { type: 'context.truncated', callId: 'c1', handle: 'h1', kind: 'truncated', keptChars: 100 },
  { type: 'context.truncated', callId: 'c2', handle: 'h2', kind: 'truncated', keptChars: 50 },
  { type: 'context.truncated', callId: 'c2', handle: 'h2', kind: 'omitted' },
  { type: 'instructions.loaded', path: '/work/a/AGENTS.md', content: 'first rules' },
  requested(2),
  answered(2, 'done'),
  hook('Stop'),
  { type: 'user.message', text: `${STOP_FEEDBACK}keep going` },
  { type: 'user.message', text: 'not feedback' },
  { type: 'instructions.loaded', path: '/work/a/AGENTS.md', content: 'second rules' },
  requested(3),
  answered(3, 'done again'),
];

const COMPACTED: RunEventPayload = { type: 'context.compacted', item: fixtureCompactionItem('cmp-1', 'summary'), summary: 'summary', replacedThroughSeq: 6 };

const foldAll = (events: readonly RunEvent[], ids = { runId: 'run-fixture', sessionId: 'session-fixture', fence: TEST_FENCE }): RunState => events.reduce(foldRunState, initialRunState(ids));

const folded = (payloads: readonly RunEventPayload[]): RunState => foldAll(materializeEvents(payloads, { runId: 'run-fixture', sessionId: 'session-fixture' }));

type Records = {
  hookCompletions: Record<string, number>;
  stopHookRanSinceResponse: boolean;
  stopHookContinuations: number;
  compactions: number;
  callResults: Record<string, 'completed' | 'failed'>;
  formsSinceCompaction: Record<string, number>;
  loadedInstructions: { path: string; textSha256: string; seq: number; content: string }[];
};

const recordsOf = (state: RunState): Records => {
  const view = state as unknown as Records;
  return {
    hookCompletions: view.hookCompletions,
    stopHookRanSinceResponse: view.stopHookRanSinceResponse,
    stopHookContinuations: view.stopHookContinuations,
    compactions: view.compactions,
    callResults: view.callResults,
    formsSinceCompaction: view.formsSinceCompaction,
    loadedInstructions: view.loadedInstructions,
  };
};

describe('the facts a reader needs are kept in RunState when their events are appended (rows 5, 8c, 8e, 21)', () => {
  it('starts every record empty', () => {
    expect(recordsOf(initialRunState({ runId: 'r', sessionId: 's', fence: TEST_FENCE }))).toEqual({
      hookCompletions: {},
      stopHookRanSinceResponse: false,
      stopHookContinuations: 0,
      compactions: 0,
      callResults: {},
      formsSinceCompaction: {},
      loadedInstructions: [],
    });
  });

  it('counts the completed hooks of each event, the stop-hook continuations and the compactions (row 5)', () => {
    const state = recordsOf(folded(JOURNAL));
    expect(state.hookCompletions).toEqual({ SessionStart: 1, UserPromptSubmit: 1, Stop: 1 });
    expect(state.stopHookContinuations).toBe(1);
    expect(state.compactions).toBe(0);
  });

  it('says whether a Stop hook ran after the last model response, and resets at each response (row 5)', () => {
    expect(recordsOf(folded(JOURNAL)).stopHookRanSinceResponse).toBe(false);
    expect(recordsOf(folded([...JOURNAL, hook('Stop')])).stopHookRanSinceResponse).toBe(true);
    const answeredAgain = recordsOf(folded([...JOURNAL, hook('Stop'), requested(4), answered(4, 'again')]));
    expect(answeredAgain.stopHookRanSinceResponse).toBe(false);
    expect(answeredAgain.hookCompletions).toEqual({ SessionStart: 1, UserPromptSubmit: 1, Stop: 2 });
  });

  it('keeps the result status of every completed call by call id (row 8c)', () => {
    expect(recordsOf(folded(JOURNAL)).callResults).toEqual({ c1: 'completed', c2: 'failed' });
  });

  it('keeps the kept characters of each truncated output since the last compaction, dropping an omitted one (row 8e)', () => {
    expect(recordsOf(folded(JOURNAL)).formsSinceCompaction).toEqual({ c1: 100 });
  });

  it('clears the forms at a rejected compaction too, which is not counted as a compaction (rows 5 and 8e)', () => {
    const rejected = recordsOf(
      folded([
        ...JOURNAL,
        COMPACTED,
        { type: 'context.truncated', callId: 'c2', handle: 'h2', kind: 'truncated', keptChars: 7 },
        { type: 'context.compaction_rejected', item: { type: 'message', role: 'user', content: '<conversation_summary>\nsummary\n</conversation_summary>' } },
      ]),
    );
    expect(rejected.formsSinceCompaction).toEqual({});
    expect(rejected.compactions).toBe(1);
  });

  it('clears the forms at a compaction and counts it, then keeps forms truncated after it (rows 5 and 8e)', () => {
    const afterCompaction = recordsOf(folded([...JOURNAL, COMPACTED]));
    expect(afterCompaction.compactions).toBe(1);
    expect(afterCompaction.formsSinceCompaction).toEqual({});
    const truncatedAgain = recordsOf(folded([...JOURNAL, COMPACTED, { type: 'context.truncated', callId: 'c2', handle: 'h2', kind: 'truncated', keptChars: 7 }]));
    expect(truncatedAgain.formsSinceCompaction).toEqual({ c2: 7 });
  });

  it('keeps the latest content of each loaded instruction file next to its path, hash and seq (row 21)', () => {
    const state = recordsOf(folded(JOURNAL));
    expect(state.loadedInstructions.map((entry) => ({ path: entry.path, content: entry.content }))).toEqual([{ path: '/work/a/AGENTS.md', content: 'second rules' }]);
  });
});

const idsOf = (run: { id: string; sessionId: string }, store: Pick<RuntimeStore, 'getSession'>) => ({ runId: run.id, sessionId: run.sessionId, fence: store.getSession(run.sessionId)?.fenceNonce ?? '' });

const storedRun = async () => {
  const { dbPath, clock, store } = harness();
  const run = await enqueue(store, newSession(store).id, 'do the task');
  const claim = mustClaim(store, 'w1');
  return { dbPath, clock, store, run, claim };
};

describe('recovery: the records survive a snapshot and a crash, and agree with a fold of the journal', () => {
  it('writes a snapshot state version above 13, since the state gained fields', async () => {
    const { store, run, claim } = await storedRun();
    expect(store.append(claim, JOURNAL.slice(1)).kind).toBe('ok');
    const events = store.readRunEvents(run.id, 0, 1000);
    expect(encodedRunState(foldAll(events, idsOf(run, store))).json()['stateVersion']).toBeGreaterThan(13);
  });

  it('treats a version 13 snapshot, written before the records, as absent so that the records are folded from the journal', async () => {
    const { store, run, claim } = await storedRun();
    expect(store.append(claim, JOURNAL.slice(1)).kind).toBe('ok');
    const events = store.readRunEvents(run.id, 0, 1000);
    const encoded = encodedRunState(foldAll(events, idsOf(run, store)));
    encoded.mutate("json_set(state_json, '$.stateVersion', 13)");
    expect(encoded.read()).toBeUndefined();
    expect(recordsOf(await foldedRunState(store, run.id))).toEqual(recordsOf(foldAll(events, idsOf(run, store))));
  });

  it('after a crash between a snapshot and later appends, snapshot plus tail gives the same records as a fold of the whole journal', async () => {
    const { dbPath, clock, store, run, claim } = await storedRun();
    const split = 12;
    expect(store.append(claim, JOURNAL.slice(1, split)).kind).toBe('ok');
    const early = store.readRunEvents(run.id, 0, 1000);
    const encodedEarly = encodedRunState(foldAll(early, idsOf(run, store)));
    expect(store.append(claim, [...JOURNAL.slice(split), COMPACTED, hook('Stop')]).kind).toBe('ok');

    const reopened = openStoreAt(dbPath, clock);
    const recovered = reopened.readRunEvents(run.id, early.at(-1)!.seq, 1000).reduce(foldRunState, encodedEarly.read() as RunState);
    expect(await foldedRunState(reopened, run.id)).toEqual(foldAll(reopened.readRunEvents(run.id, 0, 1000), idsOf(run, store)));
    const whole = foldAll(reopened.readRunEvents(run.id, 0, 1000), idsOf(run, store));
    expect(recordsOf(recovered)).toEqual(recordsOf(whole));
    expect(recordsOf(recovered)).toEqual({
      hookCompletions: { SessionStart: 1, UserPromptSubmit: 1, Stop: 2 },
      stopHookRanSinceResponse: true,
      stopHookContinuations: 1,
      compactions: 1,
      callResults: { c1: 'completed', c2: 'failed' },
      formsSinceCompaction: {},
      loadedInstructions: [expect.objectContaining({ path: '/work/a/AGENTS.md', content: 'second rules' })],
    });
  });
});
