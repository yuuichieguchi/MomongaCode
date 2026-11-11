import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { LEASE_MS, enqueue, harness, mustClaim, newSession, rawDb } from '../helpers.ts';
import { appendForeignRunEvent } from './fixtures.ts';

const call = (callId: string): RunEventPayload => ({ type: 'tool.call', callId, providerCallId: callId, name: 'Write', kind: 'edit', title: callId, rawInput: { id: callId } });

const started = (callId: string, idemKey: string): RunEventPayload => ({ type: 'tool.started', callId, idemKey });

const completed = (callId: string): RunEventPayload => ({ type: 'tool.completed', callId, status: 'completed', output: `output of ${callId}` });

const notice: RunEventPayload = { type: 'notice', level: 'info', message: 'from the previous build', code: 'previous.build' };

const appendAsPreviousBuild = (dbPath: string, runId: string, payloads: readonly RunEventPayload[]): number[] => {
  const db = rawDb(dbPath);
  return payloads.map((payload) => {
    const { type, ...rest } = payload;
    return appendForeignRunEvent(db, runId, type, rest);
  });
};

const derivedColumns = (dbPath: string, runId: string, seq: number) =>
  rawDb(dbPath).prepare('SELECT call_id, tool_name, notice_code FROM events WHERE run_id = ? AND seq = ?').get(runId, seq);

describe('derived records of rows a previous build appended (H7, 11.5)', () => {
  it('a read repairs the derived records, and claim repairs the derived columns, from the watermark on', async () => {
    const { store, dbPath, clock } = harness();
    const run = await enqueue(store, newSession(store).id, 'task');
    mustClaim(store, 'w-old');
    const [callSeq, , noticeSeq] = appendAsPreviousBuild(dbPath, run.id, [call('c1'), started('c1', 'k1'), notice]);
    if (callSeq === undefined || noticeSeq === undefined) throw new Error('the previous build appended no rows');
    expect(await store.startedCallsOf(run.id)).toEqual([{ callId: 'c1', name: 'Write', idemKey: 'k1' }]);
    clock.advance(LEASE_MS + 1);
    const claim = mustClaim(store, 'w-new');
    expect(claim.runId).toBe(run.id);
    expect(derivedColumns(dbPath, run.id, callSeq)).toEqual({ call_id: 'c1', tool_name: 'Write', notice_code: null });
    expect(derivedColumns(dbPath, run.id, noticeSeq)).toEqual({ call_id: null, tool_name: null, notice_code: 'previous.build' });
    expect(await store.toolCallSeq(run.id, 'c1')).toBe(callSeq);
    expect(await store.startedCallsOf(run.id)).toEqual([{ callId: 'c1', name: 'Write', idemKey: 'k1' }]);
    expect(await store.hasNoticeCode(run.id, 'previous.build')).toBe(true);
  });

  it('repairs the tail before recording an append that follows rows of a previous build', async () => {
    const { store, dbPath } = harness();
    const run = await enqueue(store, newSession(store).id, 'task');
    const claim = mustClaim(store, 'w1');
    appendAsPreviousBuild(dbPath, run.id, [call('c1'), started('c1', 'k1'), call('c2'), started('c2', 'k2')]);
    const result = store.append({ ...claim }, [completed('c1')]);
    expect(result.kind).toBe('ok');
    expect(await store.startedCallsOf(run.id)).toEqual([{ callId: 'c2', name: 'Write', idemKey: 'k2' }]);
  });

  it('records each event once when the repair and the appends interleave', async () => {
    const { store, dbPath, clock } = harness();
    const run = await enqueue(store, newSession(store).id, 'task');
    mustClaim(store, 'w-old');
    appendAsPreviousBuild(dbPath, run.id, [call('c1'), started('c1', 'k1')]);
    clock.advance(LEASE_MS + 1);
    const claim = mustClaim(store, 'w-new');
    store.append(claim, [completed('c1'), call('c3'), started('c3', 'k3')]);
    clock.advance(LEASE_MS + 1);
    mustClaim(store, 'w-third');
    expect(await store.startedCallsOf(run.id)).toEqual([{ callId: 'c3', name: 'Write', idemKey: 'k3' }]);
    const watermark = rawDb(dbPath).prepare('SELECT MIN(through_seq) AS low FROM derived_through WHERE run_id = ?').get(run.id);
    expect(Number(watermark?.['low'])).toBe(store.getRun(run.id)?.lastSeq);
  });
});
