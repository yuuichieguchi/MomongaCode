import { describe, expect, it } from 'vitest';
import { LOOP_GROUPS_KEPT } from '@momonga/protocol';
import type { RunEvent, RunEventPayload, RunState } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import { fixtureCompactionItem } from '@momonga/testkit';
import { enqueue, harness, mustClaim, newSession, rawDb } from './helpers.ts';
import { encodedRunState, foldedRunState, roundTripped } from './run-state-codec.ts';
import { foldOf, inheritedEvent, responded, task, taskItem } from './inherit-fixtures.ts';
import { TEST_FENCE } from '@momonga/testkit';

const USAGE = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };

const echoCall = (callId: string, value: string) => ({
  type: 'function_call' as const,
  id: `fc_${callId}`,
  call_id: callId,
  name: 'Echo',
  arguments: JSON.stringify({ value }),
  status: 'completed' as const,
});

const batch = (step: number, calls: { callId: string; value: string; output?: string }[]): RunEventPayload[] => [
  { type: 'model.requested', step, attempt: 1, digest: `d${step}`, body: { tool_choice: 'auto' } },
  { type: 'model.responded', step, attempt: 1, response: { status: 'completed', output: calls.map((entry) => echoCall(entry.callId, entry.value)), usage: USAGE } },
  ...calls.map((entry): RunEventPayload => ({ type: 'tool.call', callId: entry.callId, providerCallId: entry.callId, name: 'Echo', kind: 'read', title: `Echo ${entry.value}`, rawInput: { value: entry.value } })),
  ...calls.flatMap((entry): RunEventPayload[] =>
    entry.output === undefined ? [] : [{ type: 'tool.completed', callId: entry.callId, status: 'completed', output: entry.output }],
  ),
];

describe('loop groups folded into run state', () => {
  it('start empty', () => {
    const state = initialRunState({ runId: 'run-loop', sessionId: 'sess-loop', fence: TEST_FENCE });
    expect(state.loopGroups).toEqual([]);
    expect(state.loopOpen).toBeUndefined();
  });

  it('keep the newest group open until the next function_call, so a parallel batch closes with both outputs', () => {
    const open = foldOf([task('loop'), ...batch(1, [{ callId: 'a1', value: 'x', output: 'one' }, { callId: 'a2', value: 'y', output: 'two' }])]);
    expect(open.loopGroups).toEqual([]);
    expect(open.loopOpen?.callIds).toEqual(['a1', 'a2']);
    expect(Object.keys(open.loopOpen?.outputs ?? {}).sort()).toEqual(['a1', 'a2']);

    const closed = foldOf([
      task('loop'),
      ...batch(1, [{ callId: 'a1', value: 'x', output: 'one' }, { callId: 'a2', value: 'y', output: 'two' }]),
      ...batch(2, [{ callId: 'b1', value: 'x' }]),
    ]);
    expect(closed.loopGroups).toHaveLength(1);
    expect(closed.loopGroups[0]?.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(closed.loopGroups[0]?.outputSignature).toMatch(/^[0-9a-f]{64}$/);
    expect(closed.loopOpen?.callIds).toEqual(['b1']);
  });

  it('pushes a group without an output signature when an output is missing at the next call', () => {
    const state = foldOf([task('loop'), ...batch(1, [{ callId: 'a1', value: 'x', output: 'one' }, { callId: 'a2', value: 'y' }]), ...batch(2, [{ callId: 'b1', value: 'x' }])]);
    expect(state.loopGroups).toHaveLength(1);
    expect(state.loopGroups[0]?.outputSignature).toBeUndefined();
  });

  it('gives equal signatures to equal calls and different ones to different calls', () => {
    const state = foldOf([
      task('loop'),
      ...batch(1, [{ callId: 'a1', value: 'same', output: 'r' }]),
      ...batch(2, [{ callId: 'a2', value: 'same', output: 'r' }]),
      ...batch(3, [{ callId: 'a3', value: 'other', output: 'r' }]),
      ...batch(4, [{ callId: 'a4', value: 'x' }]),
    ]);
    const [first, second, third] = state.loopGroups;
    expect(second?.signature).toBe(first?.signature);
    expect(second?.outputSignature).toBe(first?.outputSignature);
    expect(third?.signature).not.toBe(first?.signature);
  });

  it('keeps at most 32 groups, newest last', () => {
    expect(LOOP_GROUPS_KEPT).toBe(32);
    const payloads = [task('loop'), ...Array.from({ length: 40 }, (_unused, index) => batch(index + 1, [{ callId: `c${index}`, value: `v${index}`, output: `o${index}` }])).flat()];
    const state = foldOf(payloads);
    expect(state.loopGroups).toHaveLength(32);
    const signatureOf = (value: string) => foldOf([task('loop'), ...batch(1, [{ callId: 'z', value, output: 'o' }]), ...batch(2, [{ callId: 'y', value: 'next' }])]).loopGroups[0]?.signature;
    expect(state.loopGroups.at(-1)?.signature).toBe(signatureOf('v38'));
  });

  it('are untouched by a compaction', () => {
    const before = foldOf([
      task('loop'),
      ...batch(1, [{ callId: 'a1', value: 'x', output: 'one' }]),
      ...batch(2, [{ callId: 'a2', value: 'x', output: 'one' }]),
    ]);
    const after = foldOf([
      task('loop'),
      ...batch(1, [{ callId: 'a1', value: 'x', output: 'one' }]),
      ...batch(2, [{ callId: 'a2', value: 'x', output: 'one' }]),
      { type: 'context.compacted', item: fixtureCompactionItem('cmp-1', 'S'), summary: 'S', replacedThroughSeq: 3 },
    ]);
    expect(after.history.length).toBeLessThan(before.history.length);
    expect(after.loopGroups).toEqual(before.loopGroups);
    expect(after.loopOpen).toEqual(before.loopOpen);
  });

  it('are run-local: an inherited history with calls does not seed them', () => {
    const state = foldOf(
      [
        task('continue'),
        inheritedEvent({
          fromRunId: 'run-source',
          fromLastSeq: 9,
          history: [
            { seq: 1, item: taskItem('earlier') },
            { seq: 2, item: echoCall('p1', 'x') },
            { seq: 3, item: { type: 'function_call_output', call_id: 'p1', output: 'one' } },
            { seq: 4, item: echoCall('p2', 'x') },
            { seq: 5, item: { type: 'function_call_output', call_id: 'p2', output: 'one' } },
          ],
          nextItemSeq: 6,
        }),
      ],
      'run-next',
    );
    expect(state.history.some((entry) => entry.item.type === 'function_call')).toBe(true);
    expect(state.loopGroups).toEqual([]);
    expect(state.loopOpen).toBeUndefined();
  });
});

describe('loop groups through a snapshot', () => {
  const payloads: RunEventPayload[] = [
    { type: 'run.started', attempt: 1, now: 1, pins: { model: 'fm' } },
    ...batch(1, [{ callId: 'a1', value: 'x', output: 'one' }, { callId: 'a2', value: 'y', output: 'two' }]),
    ...batch(2, [{ callId: 'b1', value: 'x', output: 'one' }]),
    ...batch(3, [{ callId: 'c1', value: 'x' }]),
  ];

  const stored = async (split: number) => {
    const { store } = harness();
    const run = await enqueue(store, newSession(store).id, 'loop');
    const claim = mustClaim(store, 'w1');
    expect(store.append(claim, payloads.slice(0, split)).kind).toBe('ok');
    const head: RunEvent[] = store.readRunEvents(run.id, 0, 1000);
    const headState = head.reduce(foldRunState, initialRunState({ runId: run.id, sessionId: run.sessionId, fence: store.getSession(run.sessionId)?.fenceNonce ?? '' }));
    expect(store.append(claim, payloads.slice(split)).kind).toBe('ok');
    const all: RunEvent[] = store.readRunEvents(run.id, 0, 1000);
    const full = all.reduce(foldRunState, initialRunState({ runId: run.id, sessionId: run.sessionId, fence: store.getSession(run.sessionId)?.fenceNonce ?? '' }));
    return { store, run, full, headState, tail: all.slice(head.length) };
  };

  it.for([5, 9, 12])('folds identically from an encoded state taken after %i payloads and from all events', async (split) => {
    const { store, run, full, headState, tail } = await stored(split);
    const resumed = tail.reduce(foldRunState, roundTripped(headState) as RunState);
    expect(await foldedRunState(store, run.id)).toEqual(full);
    expect(full.loopGroups).toHaveLength(2);
    expect(resumed.loopGroups).toEqual(full.loopGroups);
    expect(resumed.loopOpen).toEqual(full.loopOpen);
  });

  it.for([
    ['loopGroups that is not an array', "json_set(state_json, '$.loopGroups', 'x')"],
    ['a loop group without a string signature', "json_set(state_json, '$.loopGroups[0].signature', 7)"],
    ['a loop group whose outputSignature is not a string', "json_set(state_json, '$.loopGroups[0].outputSignature', 7)"],
    ['a loopOpen without callIds', "json_remove(state_json, '$.loopOpen.callIds')"],
    ['no loopGroups', "json_remove(state_json, '$.loopGroups')"],
    ['a loop group signature that is not 64 hex characters', "json_set(state_json, '$.loopGroups[0].signature', 'abc')"],
    ['a loop group signature in upper case hex', "json_set(state_json, '$.loopGroups[0].signature', upper(json_extract(state_json, '$.loopGroups[0].signature')))"],
    ['a loop group outputSignature that is not 64 hex characters', "json_set(state_json, '$.loopGroups[0].outputSignature', 'abc')"],
    ['a loopOpen with more calls than callIds', "json_set(state_json, '$.loopOpen.callIds', json('[]'))"],
    ['a loopOpen output hash that is not 64 hex characters', "json_set(state_json, '$.loopOpen.outputs', json('{\"c1\":\"abc\"}'))"],
  ] as const)('reports a snapshot with %s as corrupt', async ([, expression]) => {
    const { full } = await stored(payloads.length);
    const encoded = encodedRunState(full);
    encoded.mutate(expression);
    expect(() => encoded.read()).toThrow(/corrupt/);
  });

  it('reports a snapshot with more than 32 loop groups as corrupt', async () => {
    const { full } = await stored(payloads.length);
    const groups = JSON.stringify(Array.from({ length: 33 }, () => ({ signature: 'a'.repeat(64) })));
    const encoded = encodedRunState(full);
    encoded.mutate(`json_set(state_json, '$.loopGroups', json('${groups}'))`);
    expect(() => encoded.read()).toThrow(/corrupt/);
  });
});
