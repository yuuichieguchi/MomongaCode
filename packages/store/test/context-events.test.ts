import { describe, expect, it } from 'vitest';
import type { RunEvent, RunState } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import { fixtureCompactionItem } from '@momonga/testkit';
import { SNAPSHOT_STATE_VERSION, decodeEvent } from '../src/codec.ts';

const ENVELOPE = { id: 9, runId: 'r1', sessionId: 's1', seq: 5, step: 1, leaseToken: 1, createdAt: 10 };

const row = (payload: Record<string, unknown>): never =>
  ({
    id: ENVELOPE.id,
    run_id: ENVELOPE.runId,
    session_id: ENVELOPE.sessionId,
    seq: ENVELOPE.seq,
    step: ENVELOPE.step,
    lease_token: ENVELOPE.leaseToken,
    created_at: ENVELOPE.createdAt,
    type: payload['type'],
    payload_json: JSON.stringify(payload),
  }) as never;

const start = (): RunState => initialRunState({ runId: 'r1', sessionId: 's1' });
const item = fixtureCompactionItem('cmp-1', 'so far');
const messageItem = { type: 'message', role: 'user', content: '<conversation_summary>\nso far\n</conversation_summary>' };

const NEW_EVENTS: [string, Record<string, unknown>][] = [
  ['context.governing_loaded', { active: [{ id: 'g1', textSha256: 'aa' }], conflicts: [{ target: 'pandas', ids: ['g1', 'g2'] }] }],
  ['context.memories_loaded', { memories: [{ id: 'm1', status: 'verified' }] }],
  ['context.contribution', { items: [{ kind: 'memory', id: 'm1', contributed: true }] }],
];

describe('context events in the journal', () => {
  it.each(NEW_EVENTS)('decodes %s', (type, fields) => {
    const payload = { type, ...fields };
    expect(decodeEvent(row(payload))).toEqual({ ...payload, ...ENVELOPE });
  });

  it.each(NEW_EVENTS.filter(([type]) => type === 'context.contribution'))('folds %s without changing state beyond the seq', (type, fields) => {
    const before = start();
    const after = foldRunState(before, { type, ...fields, ...ENVELOPE } as unknown as RunEvent);
    expect(after).toEqual({ ...before, step: 1, lastSeq: 5 });
  });

  it('folds context.governing_loaded into the set last loaded, and the next one replaces it', () => {
    const [, first] = NEW_EVENTS[0] as [string, Record<string, unknown>];
    const loaded = foldRunState(start(), { type: 'context.governing_loaded', ...first, ...ENVELOPE } as unknown as RunEvent);
    expect(loaded.governingLoaded).toEqual({ active: [{ id: 'g1', textSha256: 'aa' }], conflicts: [{ target: 'pandas', ids: ['g1', 'g2'] }] });
    const emptied = foldRunState(loaded, { type: 'context.governing_loaded', active: [], conflicts: [], ...ENVELOPE } as unknown as RunEvent);
    expect(emptied.governingLoaded).toEqual({ active: [], conflicts: [] });
  });

  it('folds context.memories_loaded into the set last loaded', () => {
    const [, fields] = NEW_EVENTS[1] as [string, Record<string, unknown>];
    const loaded = foldRunState(start(), { type: 'context.memories_loaded', ...fields, ...ENVELOPE } as unknown as RunEvent);
    expect(loaded.memoriesLoaded).toEqual([{ id: 'm1', status: 'verified' }]);
  });

  it('decodes and folds a context.compacted recorded before source, fidelity and guidelineVersion', () => {
    const payload = { type: 'context.compacted', item, summary: 'so far', replacedThroughSeq: 3 };
    const event = decodeEvent(row(payload)) as RunEvent;
    expect(event).toEqual({ ...payload, ...ENVELOPE });
    expect(foldRunState(start(), event).summary).toEqual({ item, summary: 'so far', replacedThroughSeq: 3 });
  });

  it('decodes and folds a deterministic context.compacted with a message item', () => {
    const payload = { type: 'context.compacted', item: messageItem, summary: 'so far', replacedThroughSeq: 3, source: 'deterministic' };
    const event = decodeEvent(row(payload)) as RunEvent;
    expect(foldRunState(start(), event).summary).toEqual({ item: messageItem, summary: 'so far', replacedThroughSeq: 3 });
  });

  describe('tool.completed file and exit facts', () => {
    const base = { type: 'tool.completed', callId: 'c1', status: 'completed', output: 'ok' };
    const files = [{ path: '/p/a.ts', sha256: 'a'.repeat(64), access: 'write' }];

    it('decodes an event recorded before files and exitCode', () => {
      expect(decodeEvent(row(base))).toEqual({ ...base, ...ENVELOPE });
    });

    it('decodes files and exitCode as recorded', () => {
      const payload = { ...base, files, exitCode: 0 };
      expect(decodeEvent(row(payload))).toEqual({ ...payload, ...ENVELOPE });
    });

    it.each([
      ['files that are not an array', { files: 'a.ts' }],
      ['a file without a sha256', { files: [{ path: '/p/a.ts', access: 'write' }] }],
      ['a file with an unknown access', { files: [{ path: '/p/a.ts', sha256: 'a'.repeat(64), access: 'delete' }] }],
      ['an exit code that is not an integer', { exitCode: '1' }],
    ])('refuses %s as corrupt', (_name, extra) => {
      expect(() => decodeEvent(row({ ...base, ...extra }))).toThrow(/corrupt/);
    });
  });

  it('keeps the same summary state when the new fields are present', () => {
    const event = {
      type: 'context.compacted',
      item,
      summary: 'so far',
      replacedThroughSeq: 3,
      source: 'model',
      fidelity: { fabricated: [], identifiers: 1, retained: 1, sections: 'complete' },
      guidelineVersion: 2,
      ...ENVELOPE,
    } as RunEvent;
    expect(foldRunState(start(), event).summary).toEqual({ item, summary: 'so far', replacedThroughSeq: 3 });
    expect(SNAPSHOT_STATE_VERSION).toBe(14);
  });
});
