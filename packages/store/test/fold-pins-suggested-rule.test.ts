import { describe, expect, it } from 'vitest';
import type { RunEvent, RunEventPayload, RunState } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import { FIXTURE_RUN_ID, FIXTURE_SESSION_ID, fixtureSubjectDigest, materializeEvents } from '@momonga/testkit';
import { enqueue, harness, mustClaim, newSession, rawDb } from './helpers.ts';

const start = () => initialRunState({ runId: FIXTURE_RUN_ID, sessionId: FIXTURE_SESSION_ID });
const foldAll = (events: readonly RunEvent[], from: RunState = start()) => events.reduce(foldRunState, from);

const FIRST_PINS = {
  model: 'fm',
  systemPromptDigest: fixtureSubjectDigest('system prompt'),
  toolSetDigest: fixtureSubjectDigest('tool set'),
  capabilities: { contextWindow: 4096, parallelToolCalls: false },
};

const SECOND_PINS = { ...FIRST_PINS, toolSetDigest: fixtureSubjectDigest('other tool set') };

const OPTIONS = [
  { optionId: 'opt-ao', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'opt-aa', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'opt-ro', name: 'Reject once', kind: 'reject_once' },
  { optionId: 'opt-ra', name: 'Reject always', kind: 'reject_always' },
] as const;

const DIGEST = fixtureSubjectDigest('npm test');
const RULE = 'Bash(npm test:*)';

const requested = (suggestedRule?: string): RunEventPayload[] => [
  { type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Bash', kind: 'execute', title: 'npm test', rawInput: { command: 'npm test' } },
  {
    type: 'tool.permission.requested',
    approvalId: 'ap1',
    callId: 'c1',
    options: OPTIONS.map((option) => ({ ...option })),
    subjectDigest: DIGEST,
    reason: 'edits require approval',
    ...(suggestedRule === undefined ? {} : { suggestedRule }),
    shown: { title: 'approval', input: {} },
  },
];

describe('run pins in the fold', () => {
  it('has no pins before any run.started', () => {
    expect(start()).not.toHaveProperty('pins');
  });

  it('records the pins of the first run.started', () => {
    const state = foldAll(materializeEvents([{ type: 'run.started', attempt: 1, now: 10, pins: FIRST_PINS }]));
    expect(state.pins).toEqual(FIRST_PINS);
    expect(state.attempt).toBe(1);
  });

  it('keeps the first pins when a later attempt starts with different pins', () => {
    const state = foldAll(
      materializeEvents([
        { type: 'run.started', attempt: 1, now: 10, pins: FIRST_PINS },
        { type: 'run.started', attempt: 2, now: 20, pins: SECOND_PINS },
      ]),
    );
    expect(state.pins).toEqual(FIRST_PINS);
    expect(state.attempt).toBe(2);
  });
});

describe('suggested rule in the fold', () => {
  it('stores the suggested rule on the pending call awaiting approval', () => {
    const state = foldAll(materializeEvents(requested(RULE)));
    expect(state.pendingCalls['c1']).toEqual({
      name: 'Bash',
      providerCallId: 'c1',
      arguments: { command: 'npm test' },
      status: 'awaiting_approval',
      approvalId: 'ap1',
      subjectDigest: DIGEST,
      options: OPTIONS.map((option) => ({ ...option })),
      suggestedRule: RULE,
    });
  });

  it('omits the suggested rule when the request carries none', () => {
    const state = foldAll(materializeEvents(requested()));
    expect(state.pendingCalls['c1']).not.toHaveProperty('suggestedRule');
  });

  it.each(OPTIONS.map((option) => [option.kind, option.optionId] as const))(
    'clears the suggested rule from the call on %s and carries it in the resolution',
    (kind, optionId) => {
      const state = foldAll(materializeEvents([...requested(RULE), { type: 'tool.permission.resolved', approvalId: 'ap1', optionId }]));
      expect(state.pendingCalls['c1']).not.toHaveProperty('suggestedRule');
      expect(state.pendingCalls['c1']).not.toHaveProperty('options');
      expect(state.pendingCalls['c1']?.resolution).toEqual({ optionId, kind, subjectDigest: DIGEST, suggestedRule: RULE });
    },
  );

  it('resolves without a suggested rule when none was requested', () => {
    const state = foldAll(materializeEvents([...requested(), { type: 'tool.permission.resolved', approvalId: 'ap1', optionId: 'opt-ao' }]));
    expect(state.pendingCalls['c1']?.resolution).toEqual({ optionId: 'opt-ao', kind: 'allow_once', subjectDigest: DIGEST });
  });
});

describe('snapshot codec for pins and suggested rules', () => {
  const stored = async () => {
    const { dbPath, store } = harness();
    const run = await enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    const payloads: RunEventPayload[] = [
      { type: 'run.started', attempt: 1, now: 10, pins: FIRST_PINS },
      { type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Bash', kind: 'execute', title: 'a', rawInput: { command: 'a' } },
      {
        type: 'tool.permission.requested',
        approvalId: 'ap1',
        callId: 'c1',
        options: OPTIONS.map((option) => ({ ...option })),
        subjectDigest: DIGEST,
        reason: 'edits require approval',
        suggestedRule: RULE,
        shown: { title: 'approval', input: {} },
      },
      { type: 'tool.call', callId: 'c2', providerCallId: 'c2', name: 'Bash', kind: 'execute', title: 'b', rawInput: { command: 'b' } },
      {
        type: 'tool.permission.requested',
        approvalId: 'ap2',
        callId: 'c2',
        options: OPTIONS.map((option) => ({ ...option })),
        subjectDigest: DIGEST,
        reason: 'edits require approval',
        suggestedRule: RULE,
        shown: { title: 'approval', input: {} },
      },
      { type: 'tool.permission.resolved', approvalId: 'ap2', optionId: 'opt-aa' },
    ];
    expect(store.append(claim, payloads).kind).toBe('ok');
    const events = store.readRunEvents(run.id, 0, 1000);
    const state = foldAll(events, initialRunState({ runId: run.id, sessionId: run.sessionId }));
    expect(store.writeSnapshot(claim, state.lastSeq, state)).toEqual({ kind: 'ok' });
    const mutate = (expression: string): void => {
      rawDb(dbPath).prepare(`UPDATE snapshots SET state_json = ${expression} WHERE run_id = ?`).run(run.id);
    };
    return { store, run, state, mutate };
  };

  it('round-trips pins and suggested rules through a snapshot', async () => {
    const { store, run, state } = await stored();
    expect(state.pins).toEqual(FIRST_PINS);
    expect(state.pendingCalls['c1']?.suggestedRule).toBe(RULE);
    expect(state.pendingCalls['c2']?.resolution?.suggestedRule).toBe(RULE);
    expect(store.load(run.id).snapshot?.state).toEqual(state);
  });

  it.each([
    ['pins that are not an object', "json_set(state_json, '$.pins', 'fm')"],
    ['pins that are an array', "json_set(state_json, '$.pins', json('[1]'))"],
    ['a non-string suggested rule on a pending call', "json_set(state_json, '$.pendingCalls.c1.suggestedRule', 7)"],
    ['a non-string suggested rule in a resolution', "json_set(state_json, '$.pendingCalls.c2.resolution.suggestedRule', 7)"],
  ])('reports a snapshot with %s as corrupt', async (_label, expression) => {
    const { store, run, mutate } = await stored();
    mutate(expression);
    expect(() => store.load(run.id)).toThrow(/corrupt/);
  });
});
