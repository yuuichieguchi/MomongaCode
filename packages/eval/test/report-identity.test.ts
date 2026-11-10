import { describe, expect, it } from 'vitest';
import { CONTEXT_DATASET_FORMAT, EvalError, TranscriptError, decodeTranscript, encodeTranscript, parseContextDataset } from '@momonga/eval';
import type { PolicyOverlay, Transcript } from '@momonga/eval';
import { contextCase, recorded } from './context-fixtures.ts';
import { buildReportAs } from './answered-fixtures.ts';
import { RESOLVED_OFF_POLICY, RESOLVED_ON_POLICY } from './fixtures.ts';

const ON = RESOLVED_ON_POLICY as unknown as PolicyOverlay;
const OFF = RESOLVED_OFF_POLICY as unknown as PolicyOverlay;
const HEAD_CODE = 'b'.repeat(64);
const MAIN_CODE = 'a'.repeat(64);

const SCENARIOS = ['a', 'b'] as const;

const dataset = parseContextDataset(
  JSON.stringify({
    format: CONTEXT_DATASET_FORMAT,
    name: 'economy',
    cases: SCENARIOS.flatMap((scenario) => [contextCase(`${scenario}-on`, scenario, 'on'), contextCase(`${scenario}-off`, scenario, 'off')]),
  }),
  'economy.json',
);

const stamped = (transcript: Transcript, policy: PolicyOverlay, codeDigest: string): Transcript => ({ ...transcript, policy, codeDigest });

const transcriptsOf = (identity: (index: number) => { policy: PolicyOverlay; codeDigest: string }): Transcript[] =>
  SCENARIOS.flatMap((scenario) => [recorded(`${scenario}-on`, 0, []), recorded(`${scenario}-off`, 0, [])]).map((transcript, index) => {
    const { policy, codeDigest } = identity(index);
    return stamped(transcript, policy, codeDigest);
  });

describe('a transcript records the identity of the run it measured', () => {
  it('keeps the policy and the code digest through encoding', () => {
    const transcript = stamped(recorded('a-on', 0, []), ON, HEAD_CODE);
    const decoded = decodeTranscript(encodeTranscript(transcript), 'a-on.0.transcript.jsonl');
    expect(decoded.policy).toEqual(ON);
    expect(decoded.codeDigest).toBe(HEAD_CODE);
  });

  it('refuses a code digest that is not a sha256 and a policy that is not a token overlay', () => {
    const badDigest = encodeTranscript(stamped(recorded('a-on', 0, []), ON, 'not-a-digest'));
    expect(() => decodeTranscript(badDigest, 'a-on.0.transcript.jsonl')).toThrow(TranscriptError);
    const badPolicy = encodeTranscript(stamped(recorded('a-on', 0, []), { context: { autoCompact: false } } as unknown as PolicyOverlay, HEAD_CODE));
    expect(() => decodeTranscript(badPolicy, 'a-on.0.transcript.jsonl')).toThrow(TranscriptError);
  });
});

describe('a report takes its identity from its transcripts', () => {
  it('records the policy and the code digest that every transcript carries', () => {
    const report = buildReportAs({ dataset, transcripts: transcriptsOf(() => ({ policy: ON, codeDigest: HEAD_CODE })), model: 'real', seed: 1 });
    expect(report.policy).toEqual(ON);
    expect(report.codeDigest).toBe(HEAD_CODE);
  });

  it('refuses transcripts that record different code digests', () => {
    const transcripts = transcriptsOf((index) => ({ policy: ON, codeDigest: index === 0 ? MAIN_CODE : HEAD_CODE }));
    expect(() => buildReportAs({ dataset, transcripts, model: 'real', seed: 1 })).toThrow(EvalError);
    expect(() => buildReportAs({ dataset, transcripts, model: 'real', seed: 1 })).toThrow(/codeDigest/);
  });

  it('refuses transcripts that record different policies', () => {
    const transcripts = transcriptsOf((index) => ({ policy: index === 0 ? OFF : ON, codeDigest: HEAD_CODE }));
    expect(() => buildReportAs({ dataset, transcripts, model: 'real', seed: 1 })).toThrow(EvalError);
    expect(() => buildReportAs({ dataset, transcripts, model: 'real', seed: 1 })).toThrow(/policy/);
  });
});
