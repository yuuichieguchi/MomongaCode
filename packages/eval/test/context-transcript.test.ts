import { describe, expect, it } from 'vitest';
import { TRANSCRIPT_FORMAT, TranscriptError, decodeTranscript, encodeTranscript } from '@momonga/eval';
import type { Transcript } from '@momonga/eval';
import type { PublicRunEvent } from '@momonga/protocol';
import { toolRoundTripTranscript } from './fixtures.ts';

const ENVELOPE = { id: 90, runId: 'r1', sessionId: 's1', seq: 90, step: 1, createdAt: 1 };

const withEvent = (transcript: Transcript, fields: Record<string, unknown>): Transcript => ({
  ...transcript,
  events: [...transcript.events, { ...ENVELOPE, ...fields } as unknown as PublicRunEvent],
});

describe('transcripts and the context events', () => {
  it('does not bump the transcript format for the context events, which only add optional fields; format 3 is the side effect of a tool call', () => {
    expect(TRANSCRIPT_FORMAT).toBe('momonga-transcript/3');
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

  it('round-trips the reflection of a run and refuses a charge that is not a context charge', () => {
    const charge = { id: 1, purpose: 'reflection' as const, runId: 'r1', project: '/w', model: 'm', inputTokens: 5, outputTokens: 1, totalTokens: 6, createdAt: 1, detail: { timing: { durationMs: 9 } } };
    const original: Transcript = { ...toolRoundTripTranscript('c1', 2), reflection: { state: 'done', charge } };
    expect(decodeTranscript(encodeTranscript(original), 'r.jsonl')).toEqual(original);
    const broken = { ...original, reflection: { state: 'done', charge: { ...charge, inputTokens: -1 } } } as Transcript;
    expect(() => decodeTranscript(encodeTranscript(broken), 'r.jsonl')).toThrow(/reflection.charge/);
  });

  it('ends a transcript with a record that counts its events, so a file cut at a line boundary is refused', () => {
    const lines = encodeTranscript(toolRoundTripTranscript('c1', 2)).split('\n').filter((line) => line !== '');
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ end: true });
    const withoutLastEvent = [...lines.slice(0, -2), lines.at(-1)].join('\n') + '\n';
    expect(() => decodeTranscript(withoutLastEvent, 'cut.jsonl')).toThrow(TranscriptError);
    expect(() => decodeTranscript(withoutLastEvent, 'cut.jsonl')).toThrow(/events/);
  });

  it('refuses a transcript with no end record', () => {
    const lines = encodeTranscript(toolRoundTripTranscript('c1', 2)).split('\n').filter((line) => line !== '');
    expect(() => decodeTranscript(lines.slice(0, -1).join('\n') + '\n', 'cut.jsonl')).toThrow(/end record/);
  });

  it('counts the events of child runs in the end record', () => {
    const parent = toolRoundTripTranscript('c1', 2);
    const withChild: Transcript = { ...parent, children: [{ runId: 'child-1', agent: 'explore', events: parent.events.slice(0, 2) }] };
    const lines = encodeTranscript(withChild).split('\n').filter((line) => line !== '');
    const withoutChildEvent = [...lines.slice(0, -2), lines.at(-1)].join('\n') + '\n';
    expect(decodeTranscript(encodeTranscript(withChild), 'child.jsonl')).toEqual(withChild);
    expect(() => decodeTranscript(withoutChildEvent, 'cut.jsonl')).toThrow(TranscriptError);
  });

  it('round-trips the governing, memory and contribution events', () => {
    const governing = withEvent(toolRoundTripTranscript('c1', 2), { type: 'context.governing_loaded', active: [{ id: 'g1', textSha256: 'aa' }], conflicts: [] });
    const memories = withEvent(governing, { type: 'context.memories_loaded', memories: [{ id: 'm1', status: 'stale' }] });
    const all = withEvent(memories, { type: 'context.contribution', items: [{ kind: 'governing', id: 'g1', contributed: true }] });
    expect(decodeTranscript(encodeTranscript(all), 'new.jsonl')).toEqual(all);
  });
});
