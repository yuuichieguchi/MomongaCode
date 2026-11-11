import { describe, expect, it } from 'vitest';
import { TRANSCRIPT_FORMAT, TranscriptError, decodeTranscript, encodeTranscript } from '@momonga/eval';
import type { RunEventPayload } from '@momonga/protocol';
import { recorded } from './context-fixtures.ts';

const unreportedCall: RunEventPayload = {
  type: 'model.responded',
  step: 1,
  attempt: 1,
  response: {
    status: 'completed',
    output: [],
    usage: { input_tokens: 1000, output_tokens: 50, total_tokens: 1050, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    momonga: { cacheReadNotReported: true },
  },
} as unknown as RunEventPayload;

describe('the transcript format records whether each call reported its cache reads', () => {
  it('is /9 and keeps a call that did not report its cache reads through a round trip', () => {
    const transcript = recorded('a-on', 0, [unreportedCall]);
    const text = encodeTranscript(transcript);

    expect(TRANSCRIPT_FORMAT).toBe('momonga-transcript/9');
    expect(JSON.parse(text.split('\n')[0] ?? '{}')).toMatchObject({ format: 'momonga-transcript/9' });
    expect(decodeTranscript(text, 'a.jsonl')).toEqual(transcript);
  });

  it('refuses a /6 transcript as retired, with the reason', () => {
    const header = { format: 'momonga-transcript/6', caseId: 'a-on', runIndex: 0, run: recorded('a-on', 0, []).run, children: [], policy: {}, codeDigest: 'c'.repeat(64) };
    const text = `${JSON.stringify(header)}\n${JSON.stringify({ end: true, events: 0, childEvents: 0 })}\n`;

    expect(() => decodeTranscript(text, 'old.jsonl')).toThrow(TranscriptError);
    expect(() => decodeTranscript(text, 'old.jsonl')).toThrow(
      'old.jsonl:1: momonga-transcript/6 transcripts do not record whether the upstream reported the cache reads of each call, so they cannot be graded as momonga-transcript/9; record the case again',
    );
  });
});
