import { describe, expect, it } from 'vitest';
import { TRANSCRIPT_FORMAT, decodeTranscript, encodeTranscript } from '@momonga/eval';
import type { Transcript } from '@momonga/eval';
import type { PublicRunEvent } from '@momonga/protocol';
import { toolRoundTripTranscript } from './fixtures.ts';

const ENVELOPE = { id: 90, runId: 'r1', sessionId: 's1', seq: 90, step: 1, createdAt: 1 };

const withEvent = (transcript: Transcript, fields: Record<string, unknown>): Transcript => ({
  ...transcript,
  events: [...transcript.events, { ...ENVELOPE, ...fields } as unknown as PublicRunEvent],
});

describe('transcripts and the context events', () => {
  it('keeps the transcript format, because older transcripts stay valid', () => {
    expect(TRANSCRIPT_FORMAT).toBe('momonga-transcript/2');
  });

  it('decodes a context.compacted written before source, fidelity and guidelineVersion', () => {
    const original = withEvent(toolRoundTripTranscript('c1', 2), { type: 'context.compacted', summary: 'so far', replacedThroughSeq: 3 });
    expect(decodeTranscript(encodeTranscript(original), 'old.jsonl')).toEqual(original);
  });

  it('round-trips a context.compacted carrying them', () => {
    const original = withEvent(toolRoundTripTranscript('c1', 2), {
      type: 'context.compacted',
      summary: 'so far',
      replacedThroughSeq: 3,
      source: 'deterministic',
      fidelity: { fabricated: ['a.ts'], identifiers: 2, retained: 1, sections: 'none' },
      guidelineVersion: 1,
    });
    expect(decodeTranscript(encodeTranscript(original), 'new.jsonl')).toEqual(original);
  });

  it('round-trips the governing, memory and contribution events', () => {
    const governing = withEvent(toolRoundTripTranscript('c1', 2), { type: 'context.governing_loaded', active: [{ id: 'g1', textSha256: 'aa' }], conflicts: [] });
    const memories = withEvent(governing, { type: 'context.memories_loaded', memories: [{ id: 'm1', status: 'stale' }] });
    const all = withEvent(memories, { type: 'context.contribution', items: [{ kind: 'governing', id: 'g1', contributed: true }] });
    expect(decodeTranscript(encodeTranscript(all), 'new.jsonl')).toEqual(all);
  });
});
