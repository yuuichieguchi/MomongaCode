import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PermissionOption, RunState } from '@momonga/protocol';
import { PROPERTY_TIMEOUT_MS } from '@momonga/testkit';
import { cfgNames } from '../../../test/formal/cfg-names.ts';
import { mustRun } from './helpers.ts';
import { FLOOR_TOKENS, UNBOUNDED_WINDOW, chainBuilder, eventsOf, expectedEntries, inheritedEventsOf, oracleState, recordedTokens, referenceHarness, referenceOf, withReader } from './support/reference.ts';
import type { ChainBuilder, ReferenceHarness } from './support/reference.ts';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

const model = cfgNames(path.resolve(import.meta.dirname, '..', '..', '..', 'specs', 'tla'), 'InheritRef');

const OPTIONS: PermissionOption[] = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
];

const LATE_OUTPUT = 'the file was written after the approval';

const windowOf = (h: ReferenceHarness, runId: string) => withReader(h.dbPath, (reader) => reader.readInheritedWindow({ runId, windowTokens: UNBOUNDED_WINDOW, floorTokens: FLOOR_TOKENS }));

const inheritedPart = (state: RunState): RunState['history'] => state.history.filter((entry) => entry.seq < state.taskSeq);

const predecessor = async (b: ChainBuilder, task: string, options: { fresh: boolean; compacted: boolean }): Promise<void> => {
  const run = await b.createRun(task, options.fresh ? { history: 'fresh' } : {});
  const claim = b.claimNext(run.id);
  if (!options.fresh) await b.inherit(claim, 'manual');
  b.started(claim, 'manual');
  b.text(claim);
  await b.tool(claim);
  b.text(claim);
  if (options.compacted) {
    const cut = b.compactionCut(run.id);
    if (cut === undefined) throw new Error(`run ${run.id} has no compaction cut`);
    b.compact(claim, cut);
  }
  await b.end(claim, { to: 'COMPLETED' });
};

const checkChild = async (h: ReferenceHarness, b: ChainBuilder, label: string): Promise<{ problems: string[]; childId: string }> => {
  const problems: string[] = [];
  const child = await b.createRun('the child task');
  const claim = b.claimNext(child.id);
  if (JSON.stringify(await b.inherit(claim, 'manual')) !== JSON.stringify({ kind: 'inherited' })) problems.push(`${label}: the child did not inherit`);
  const again = await b.inherit(claim, 'manual');
  if (inheritedEventsOf(h.store, child.id).length !== 1) problems.push(`${label}: AtMostOneReference, ${inheritedEventsOf(h.store, child.id).length} references after a second inherit answered ${JSON.stringify(again)}`);
  const event = referenceOf(h.store, child.id);
  if ('history' in event || 'summary' in event || 'evicted' in event) problems.push(`${label}: NoHistoryInEvent`);
  const before = eventsOf(h.store, child.id).length;
  const first = windowOf(h, child.id);
  const second = windowOf(h, child.id);
  if (eventsOf(h.store, child.id).length !== before) problems.push(`${label}: ReadWritesNothing`);
  if (JSON.stringify(first) !== JSON.stringify(second)) problems.push(`${label}: BuildsAgree`);
  const oracle = oracleState(h.store, child.id);
  if (JSON.stringify(first.entries) !== JSON.stringify(expectedEntries(inheritedPart(oracle), oracle.evicted, recordedTokens(h.store, h.sessionId)))) problems.push(`${label}: ReadEqualsInheritAtWrite`);
  if (first.lastSeq !== mustRun(h.store, child.id).lastSeq) problems.push(`${label}: the window names another lastSeq`);
  return { problems, childId: child.id };
};

describe('the reference inheritance on the cases of specs/tla/InheritRef.tla, through the real store and journal reader', () => {
  it('the design configuration checks the invariants these cases run', () => {
    expect(model.invariants).toEqual(expect.arrayContaining(['AtMostOneReference', 'NoHistoryInEvent', 'ReadEqualsInheritAtWrite', 'ReadWritesNothing', 'BuildsAgree']));
  });

  it('A alone or A <- B, each with or without its own compaction: the child holds one reference without history, two reads agree and write nothing, and the read equals the history the copy held', async () => {
    const problems: string[] = [];
    for (const chain of [false, true]) {
      for (const compactA of [false, true]) {
        for (const compactB of chain ? [false, true] : [false]) {
          const label = `chain ${chain} compactA ${compactA} compactB ${compactB}`;
          const h = referenceHarness();
          const b = chainBuilder(h);
          await predecessor(b, 'the first task', { fresh: true, compacted: compactA });
          if (chain) await predecessor(b, 'the second task', { fresh: false, compacted: compactB });
          problems.push(...(await checkChild(h, b, label)).problems);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('NoStaleReference: a predecessor that moves on after the reference is planned is never named by a stale reference', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    await predecessor(b, 'the first task', { fresh: true, compacted: false });
    const child = await b.createRun('the child task');
    const claim = b.claimNext(child.id);
    expect(await b.inherit(claim, 'manual')).toEqual({ kind: 'inherited' });
    const event = referenceOf(h.store, child.id);
    expect(event.fromLastSeq).toBe(mustRun(h.store, event.fromRunId).lastSeq);
  });

  it('the held-result item: a call resolved after its hold is in the window the child reads', async () => {
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
      held: { footprint: { reads: [], writes: ['local:/work/a/x.txt'] }, placeholder: (approvalId) => `waiting for ${approvalId}` },
    });
    if (asked.kind !== 'ok') throw new Error(`the hold returned ${asked.kind}`);
    b.text(claim);
    const answered = await h.store.resolveApproval(asked.approval.id, 'allow_once');
    if (answered.kind !== 'ok') throw new Error(`the answer to the hold returned ${answered.kind}`);
    b.append(claim, [{ type: 'tool.held.resolved', callId, approvalId: asked.approval.id, outcome: 'executed', status: 'completed', output: LATE_OUTPUT }]);
    b.text(claim);
    await b.end(claim, { to: 'COMPLETED' });
    const { problems, childId } = await checkChild(h, b, 'held');
    expect(problems).toEqual([]);
    expect(JSON.stringify(windowOf(h, childId).entries)).toContain(LATE_OUTPUT);
  });
});
