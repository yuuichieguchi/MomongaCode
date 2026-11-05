import { describe, expect, it } from 'vitest';
import { TranscriptError, decodeTranscript } from '@momonga/eval';
import { MAX_JSON_DEPTH } from '@momonga/foundation';

const nestedArraysText = (depth: number): string => `${'['.repeat(depth)}${']'.repeat(depth)}`;

const transcriptOf = (depth: number): string => `{"format":"not-a-transcript","extra":${nestedArraysText(depth - 1)}}\n`;

const thrownBy = (run: () => unknown): Error => {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a throw');
};

describe('eval transcripts and the one JSON depth bound', () => {
  it(`refuses a transcript line nested ${MAX_JSON_DEPTH + 1} deep, naming the line and the depth`, () => {
    const error = thrownBy(() => decodeTranscript(transcriptOf(MAX_JSON_DEPTH + 1), 'deep.jsonl'));
    expect(error).toBeInstanceOf(TranscriptError);
    expect(error.message).toMatch(/^deep\.jsonl:1: /);
    expect(error.message).toMatch(/depth/i);
    expect(error.message).toContain(String(MAX_JSON_DEPTH));
  });

  it(`passes a transcript line nested exactly ${MAX_JSON_DEPTH} deep on to the header check`, () => {
    const error = thrownBy(() => decodeTranscript(transcriptOf(MAX_JSON_DEPTH), 'deep.jsonl'));
    expect(error).toBeInstanceOf(TranscriptError);
    expect(error.message).toMatch(/^deep\.jsonl:1: first line must be a /);
  });
});
