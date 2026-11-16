import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PermissionOption, RunEventPayload, RunState } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import * as storeModule from '@momonga/store';
import { materializeEvents } from '@momonga/testkit';
import { mustRun } from './helpers.ts';
import { FLOOR_TOKENS, UNBOUNDED_WINDOW, chainBuilder, ownState, referenceHarness, withReader } from './support/reference.ts';
import { TEST_FENCE } from '@momonga/testkit';

const OPTIONS: PermissionOption[] = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
];
const FOOTPRINT = { reads: [], writes: ['local:/work/a/x.txt'] };
const LATE_OUTPUT = 'the file was written after the approval';

type Produced = { item: unknown; callId?: string; handle?: string };
type ItemFacts = { fence: string; providerCallIdOf(callId: string): string; heldToolNameOf(callId: string): string };

const exported = <T,>(name: string): T => {
  const found = (storeModule as Record<string, unknown>)[name];
  if (found === undefined) throw new Error(`@momonga/store exports no ${name}`);
  return found as T;
};

const runWithResolvedHold = async () => {
  const h = referenceHarness();
  const b = chainBuilder(h);
  const parent = await b.createRun('Write the file', { history: 'fresh' });
  const claim = b.claimNext(parent.id);
  b.started(claim, 'manual');
  const callId = b.openCall(claim, false);
  const asked = await h.store.requestApproval(claim, {
    callId,
    options: OPTIONS,
    event: { subjectDigest: 'a'.repeat(64), reason: 'outside the mandate', shown: { title: 'approval', input: {} } },
    held: { footprint: FOOTPRINT, placeholder: (approvalId) => `waiting for ${approvalId}` },
  });
  if (asked.kind !== 'ok') throw new Error(`the hold returned ${asked.kind}`);
  b.text(claim);
  const answered = await h.store.resolveApproval(asked.approval.id, 'allow_once');
  if (answered.kind !== 'ok') throw new Error(`the answer to the hold returned ${answered.kind}`);
  b.append(claim, [{ type: 'tool.held.resolved', callId, approvalId: asked.approval.id, outcome: 'executed', status: 'completed', output: LATE_OUTPUT }]);
  b.text(claim);
  await b.end(claim, { to: 'COMPLETED' });
  return { h, b, parent: mustRun(h.store, parent.id), callId };
};

describe('a run in which a held call was resolved is inherited by the next run of its session', () => {
  it('loads the conversation: the late result is in the inherited history and every item seq matches the fold', async () => {
    const { h, b, parent } = await runWithResolvedHold();
    const folded = ownState(h.store, parent.id);
    const child = await b.createRun('And now the next thing');

    expect(await b.inherit(b.claimNext(child.id), 'manual')).toEqual({ kind: 'inherited' });
    const window = withReader(h.dbPath, (reader) => reader.readInheritedWindow({ runId: child.id, windowTokens: UNBOUNDED_WINDOW, floorTokens: FLOOR_TOKENS }));

    const inherited = window.entries.filter((entry) => entry.seq < folded.nextItemSeq);
    expect(inherited).toEqual(folded.history);
    expect(JSON.stringify(inherited)).toContain(LATE_OUTPUT);
  });
});

describe('the items of the history of a run come from one table', () => {
  const state = (payloads: readonly RunEventPayload[]): RunState =>
    materializeEvents(payloads, { runId: 'run-1', sessionId: 'sess-1' }).reduce(foldRunState, initialRunState({ runId: 'run-1', sessionId: 'sess-1', fence: TEST_FENCE }));

  const CALL: RunEventPayload = { type: 'tool.call', callId: 'c1', providerCallId: 'provider-c1', name: 'Write', kind: 'edit', title: 'Write x.txt', rawInput: {} };
  const HELD: RunEventPayload[] = [
    CALL,
    { type: 'tool.permission.requested', callId: 'c1', approvalId: 'ap-1', options: OPTIONS, subjectDigest: 'a'.repeat(64), reason: 'outside the mandate', shown: { title: 'approval', input: {} } } as RunEventPayload,
    { type: 'tool.held', callId: 'c1', approvalId: 'ap-1', reason: 'outside the mandate', footprint: FOOTPRINT },
    { type: 'tool.completed', callId: 'c1', status: 'failed', output: 'waiting for ap-1', denial: { source: 'held', reason: 'outside the mandate' } },
  ];
  const RESPONSE = { status: 'completed', output: [{ type: 'message', role: 'assistant', id: 'm1', content: [{ type: 'output_text', text: 'one' }] }, { type: 'message', role: 'assistant', id: 'm2', content: [{ type: 'output_text', text: 'two' }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };

  const CASES: ReadonlyArray<readonly [string, readonly RunEventPayload[], RunEventPayload]> = [
    ['user.message', [], { type: 'user.message', text: 'the task' }],
    ['model.responded', [{ type: 'user.message', text: 'the task' }], { type: 'model.responded', step: 1, attempt: 1, response: RESPONSE } as RunEventPayload],
    ['tool.completed', [CALL], { type: 'tool.completed', callId: 'c1', status: 'completed', output: 'done', handle: 'h'.repeat(64) }],
    ['tool.reconciled', [CALL, { type: 'tool.started', callId: 'c1', idemKey: 'k-c1' }], { type: 'tool.reconciled', callId: 'c1', outcome: 'not_applied', output: 'nothing was written' }],
    ['tool.held.resolved', HELD, { type: 'tool.held.resolved', callId: 'c1', approvalId: 'ap-1', outcome: 'executed', status: 'completed', output: LATE_OUTPUT }],
    ['notice', [], { type: 'notice', level: 'info', message: 'nothing to add' }],
    ['tool.held', HELD.slice(0, 2), HELD[2] as RunEventPayload],
  ];

  it.each(CASES)('the fold appends for %s exactly the items the table produces, numbered in order', (_type, before, event) => {
    const itemsOfEvent = exported<(event: RunEventPayload, facts: ItemFacts) => Produced[]>('itemsOfEvent');
    const itemCountOf = exported<(event: RunEventPayload) => number>('itemCountOf');
    const earlier = state(before);
    const facts: ItemFacts = {
      fence: TEST_FENCE,
      providerCallIdOf: (callId) => earlier.pendingCalls[callId]?.providerCallId ?? `no call ${callId}`,
      heldToolNameOf: (callId) => earlier.heldCalls?.[callId]?.name ?? `no held call ${callId}`,
    };

    const later = state([...before, event]);

    const produced = itemsOfEvent(event, facts);
    expect(later.history.slice(earlier.history.length)).toEqual(produced.map((entry, offset) => ({ seq: earlier.nextItemSeq + offset, ...entry })));
    expect(later.nextItemSeq - earlier.nextItemSeq).toBe(produced.length);
    expect(itemCountOf(event)).toBe(produced.length);
  });

  it('names the event types that produce items once, and the fold and the reader of the inherited history keep no list of their own', () => {
    const types = exported<readonly string[]>('ITEM_EVENT_TYPES');
    expect([...types].sort()).toEqual(['model.responded', 'tool.completed', 'tool.held.resolved', 'tool.reconciled', 'user.message']);
    const source = (file: string): string => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', file), 'utf8');
    expect(source('fold.ts').match(/appendItems\(/g)?.length).toBe(1);
    expect(source('fold.ts')).toMatch(/appendItems\([^)]*itemsOfEvent\(/s);
    expect(source('inherit-reference.ts')).not.toMatch(/const itemsOfEvent|'tool\.reconciled'/);
    expect(source('fold.ts')).not.toMatch(/const itemCountOf|type: 'function_call_output'/);
  });
});
