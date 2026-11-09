import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { enqueue, harness, mustClaim, newSession, rawDb } from '../helpers.ts';
import { appendForeignRunEvent } from './fixtures.ts';

const PINNED = 'p'.repeat(64);
const COUNTER = 'c'.repeat(64);

const requested: RunEventPayload = { type: 'model.requested', step: 1, attempt: 1, digest: 'd1', pinnedDigest: PINNED, body: { model: 'fm', input: [] } } as RunEventPayload;
const call: RunEventPayload = { type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Write', kind: 'edit', title: 'c1', rawInput: { file_path: '/work/a/old.txt' }, locations: [{ path: '/work/a/old.txt' }] };
const started: RunEventPayload = { type: 'tool.started', callId: 'c1', idemKey: 'k1' };
const meter: RunEventPayload = {
  type: 'meter.observed',
  target: 'primary',
  counter: COUNTER,
  fallback: false,
  inputDigest: 'd'.repeat(64),
  itemCount: 3,
  counted: 250,
  reported: 240,
  kept: 250,
  known: 200,
  uncounted: 50,
  miss: 5,
  contextWindow: 8192,
  tokenCounting: 'estimated',
};
const responded: RunEventPayload = {
  type: 'model.responded',
  step: 1,
  attempt: 1,
  target: 'primary',
  response: { id: 'resp-1', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'the old build answered' }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
} as RunEventPayload;
const notice: RunEventPayload = { type: 'notice', level: 'info', message: 'old', code: 'old.code' };

const terminalRunWrittenByOlderBuild = () => {
  const env = harness();
  const session = newSession(env.store);
  const run = enqueue(env.store, session.id, 'task');
  mustClaim(env.store, 'w-old');
  const db = rawDb(env.dbPath);
  const seqs = [requested, call, started, meter, responded, notice].map((payload) => {
    const { type, ...rest } = payload;
    return appendForeignRunEvent(db, run.id, type, rest);
  });
  db.prepare("UPDATE runs SET status = 'COMPLETED', lease_owner = NULL WHERE id = ?").run(run.id);
  return { ...env, session, run, seqs };
};

describe('derived records of a run an older build finished, never claimed again (H7, 11.5 gap; the rule is being decided)', () => {
  it('run_records: finalTextOf (append-records.ts:257) returns the last answer text', () => {
    const { store, run } = terminalRunWrittenByOlderBuild();
    expect(store.finalTextOf(run.id)).toBe('the old build answered');
  });

  it('started_calls: startedCallsOf (append-records.ts:264) lists the call started and not finished', () => {
    const { store, run } = terminalRunWrittenByOlderBuild();
    expect(store.startedCallsOf(run.id)).toEqual([{ callId: 'c1', name: 'Write', idemKey: 'k1' }]);
  });

  it('events.call_id: toolCallSeq (append-records.ts:253) finds the call', () => {
    const { store, run, seqs } = terminalRunWrittenByOlderBuild();
    expect(store.toolCallSeq(run.id, 'c1')).toBe(seqs[1]);
  });

  it('events.tool_name: toolCallNames (runtime-store.ts:1406, statement :271) names the tool', () => {
    const { store, run } = terminalRunWrittenByOlderBuild();
    expect(store.toolCallNames(run.id)).toEqual(['Write']);
  });

  it('events.notice_code: hasNoticeCode (append-records.ts:269) sees the code', () => {
    const { store, run } = terminalRunWrittenByOlderBuild();
    expect(store.hasNoticeCode(run.id, 'old.code')).toBe(true);
  });

  it('events.model_call_json: readModelCallEvents (runtime-store.ts:1386, statement :261) lists the request and the response', () => {
    const { store, run, seqs } = terminalRunWrittenByOlderBuild();
    expect(store.readModelCallEvents(run.id).map((record) => [record.kind, record.seq])).toEqual([['requested', seqs[0]], ['responded', seqs[4]]]);
  });

  it('meter_records: meterRecordOf (append-records.ts:274) holds the observation', () => {
    const { store, run, session, seqs } = terminalRunWrittenByOlderBuild();
    expect(store.meterRecordOf(session.id, { counter: COUNTER, contextWindow: 8192, tokenCounting: 'estimated' })).toMatchObject({ runId: run.id, seq: seqs[3] });
  });

  it('run_answerers: answeringTargetsOf (append-records.ts:270) names the target', () => {
    const { store, run } = terminalRunWrittenByOlderBuild();
    expect(store.answeringTargetsOf(run.id)).toEqual(['primary']);
  });

  it('session_touched: sessionTouched.after and newest (append-records.ts:271-273, runtime-store.ts:1620) list the path', () => {
    const { store, session } = terminalRunWrittenByOlderBuild();
    expect(store.sessionTouched.after(session.id, 0, 100).map((entry) => entry.path)).toEqual(['/work/a/old.txt']);
    expect(store.sessionTouched.newest(session.id, 10).map((entry) => entry.path)).toEqual(['/work/a/old.txt']);
  });

  it('events.call_id: memories.save (memories.ts:124) finds the tool call of the finished run', () => {
    const { store, run } = terminalRunWrittenByOlderBuild();
    expect(store.memories.save({ origin: 'trusted', scope: 'project', project: '/work/a', text: 'from the old run', runId: run.id, step: 1, callId: 'c1' }).created).toBe(true);
  });

  it('events.pinned_digest: the pinned digest column (journal-reader.ts:79) holds the digest of the request', () => {
    const { dbPath, run, seqs } = terminalRunWrittenByOlderBuild();
    const [requestedSeq] = seqs;
    if (requestedSeq === undefined) throw new Error('the model.requested event was not appended');
    expect(rawDb(dbPath).prepare('SELECT pinned_digest FROM events WHERE run_id = ? AND seq = ?').get(run.id, requestedSeq)).toEqual({ pinned_digest: PINNED });
  });
});
