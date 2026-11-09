import { describe, expect, it } from 'vitest';
import {
  CONTEXT_DATASET_FORMAT,
  CONTEXT_REPORT_FORMAT,
  MODEL_DEPENDENT_METRICS,
  TRANSCRIPT_FORMAT,
  TranscriptError,
  buildContextReport,
  compareContextReports,
  decodeTranscript,
  encodeContextReport,
  encodeTranscript,
  parseContextDataset,
  parseContextReport,
} from '@momonga/eval';
import type { ContextReport, Transcript } from '@momonga/eval';
import { OTHER_REAL_TARGET, REAL_TARGET, SCRIPTED_TARGET, UNDECLARED_TARGET, UNKNOWN_ANSWERER, answeredBy } from './answered-fixtures.ts';
import type { Answerer } from './answered-fixtures.ts';
import { bash, contextCase, fidelity, recorded, summarized } from './context-fixtures.ts';

const SCENARIOS = ['a', 'b', 'c', 'd'] as const;

const dataset = parseContextDataset(
  JSON.stringify({
    format: CONTEXT_DATASET_FORMAT,
    name: 'answered',
    cases: SCENARIOS.flatMap((scenario) => [contextCase(`${scenario}-on`, scenario, 'on'), contextCase(`${scenario}-off`, scenario, 'off')]),
  }),
  'answered.json',
);

const transcriptsBy = (answerers: (caseId: string) => Answerer[] | undefined, failingOn: readonly string[] = []): Transcript[] =>
  SCENARIOS.flatMap((scenario) => [
    recorded(`${scenario}-on`, 0, [...bash('b0', 'npm test', 'failed'), summarized(3, fidelity([], 2, 2))], { status: failingOn.includes(scenario) ? 'FAILED' : 'COMPLETED' }),
    recorded(`${scenario}-off`, 0, []),
  ]).map((transcript) => {
    const who = answerers(transcript.caseId);
    return who === undefined ? transcript : answeredBy(transcript, ...who);
  });

const build = (transcripts: Transcript[], extra: Record<string, unknown> = {}): ContextReport =>
  buildContextReport({ dataset, transcripts, seed: 1, ...extra } as Parameters<typeof buildContextReport>[0]);

const realModelCheck = (baseline: ContextReport, candidate: ContextReport) =>
  compareContextReports(baseline, candidate, { seed: 1 }).gate.checks.find((check) => check.name === 'real_model');

describe('the transcript records what answered', () => {
  it('is format momonga-transcript/8', () => {
    expect(TRANSCRIPT_FORMAT).toBe('momonga-transcript/8');
  });

  it('an unknown answerer without adapter and upstreamModel is written and parsed back without those fields', () => {
    const transcript = answeredBy(recorded('a-on', 0, []), REAL_TARGET, UNKNOWN_ANSWERER);
    const decoded = decodeTranscript(encodeTranscript(transcript), 'a.jsonl');
    expect(decoded.answeredBy).toStrictEqual([REAL_TARGET, { target: 'unknown', answers: 'unknown' }]);
    expect(Object.keys(decoded.answeredBy?.[1] ?? {})).toEqual(['target', 'answers']);
  });

  it('a momonga-transcript/5 file is retired with the reason that it cannot record an answerer whose adapter and model are unknown', () => {
    const header = { format: 'momonga-transcript/5', caseId: 'a-on', runIndex: 0, run: recorded('a-on', 0, []).run, children: [], policy: {}, codeDigest: 'c'.repeat(64), answeredBy: [REAL_TARGET] };
    const text = `${JSON.stringify(header)}\n${JSON.stringify({ end: true, events: 0, childEvents: 0 })}\n`;
    expect(() => decodeTranscript(text, 'old.jsonl')).toThrow(TranscriptError);
    expect(() => decodeTranscript(text, 'old.jsonl')).toThrow(/momonga-transcript\/5 transcripts do not record .*momonga-transcript\/7/);
  });

  it('answeredBy is written and parsed back', () => {
    const transcript = answeredBy(recorded('a-on', 0, []), REAL_TARGET, SCRIPTED_TARGET);
    const decoded = decodeTranscript(encodeTranscript(transcript), 'a.jsonl');
    expect((decoded as unknown as { answeredBy: unknown }).answeredBy).toEqual([REAL_TARGET, SCRIPTED_TARGET]);
  });

  it('a momonga-transcript/4 file is retired with the reason that it does not record what answered', () => {
    const header = { format: 'momonga-transcript/4', caseId: 'a-on', runIndex: 0, run: recorded('a-on', 0, []).run, children: [], policy: {}, codeDigest: 'c'.repeat(64) };
    const text = `${JSON.stringify(header)}\n${JSON.stringify({ end: true, events: 0, childEvents: 0 })}\n`;
    expect(() => decodeTranscript(text, 'old.jsonl')).toThrow(TranscriptError);
    expect(() => decodeTranscript(text, 'old.jsonl')).toThrow(/momonga-transcript\/4.*answer/);
  });

  it('refuses an answers value other than model, script or unknown', () => {
    const transcript = answeredBy(recorded('a-on', 0, []), { ...REAL_TARGET, answers: 'human' as Answerer['answers'] });
    expect(() => decodeTranscript(encodeTranscript(transcript), 'bad.jsonl')).toThrow(TranscriptError);
  });
});

describe('the report computes its model kind from answeredBy', () => {
  it('is format momonga-eval-context-report/7, and /2, /3, /5 and /6 are retired', () => {
    expect(CONTEXT_REPORT_FORMAT).toBe('momonga-eval-context-report/7');
    const old = JSON.stringify({ format: 'momonga-eval-context-report/2' });
    expect(() => parseContextReport(old, 'old.json')).toThrow(/momonga-eval-context-report\/2/);
    const previous = encodeContextReport({ ...build(transcriptsBy(() => [REAL_TARGET])), format: 'momonga-eval-context-report/3' } as unknown as ContextReport);
    expect(() => parseContextReport(previous, 'previous.json')).toThrow(/momonga-eval-context-report\/3 reports do not record .*retired.*momonga-eval-context-report\/7/);
    const fifth = encodeContextReport({ ...build(transcriptsBy(() => [REAL_TARGET])), format: 'momonga-eval-context-report/5' } as unknown as ContextReport);
    expect(() => parseContextReport(fifth, 'fifth.json')).toThrow(/momonga-eval-context-report\/5 reports do not record the price outcome of the calls .*retired.*momonga-eval-context-report\/7/);
  });

  it('a report answered in part by an unknown answerer is unknown, and parses back with that answerer lacking adapter and upstreamModel', () => {
    const report = build(transcriptsBy((caseId) => (caseId === 'a-on' ? [REAL_TARGET, UNKNOWN_ANSWERER] : [REAL_TARGET])));
    expect(report.model).toBe('unknown');
    const parsed = parseContextReport(encodeContextReport(report), 'r.json');
    expect(parsed.answeredBy).toStrictEqual([REAL_TARGET, { target: 'unknown', answers: 'unknown' }]);
  });

  it('every answering target declared model gives real', () => {
    expect(build(transcriptsBy(() => [REAL_TARGET])).model).toBe('real');
  });

  it('a transcript with a script target gives fake, whatever model the caller passes', () => {
    const transcripts = transcriptsBy((caseId) => (caseId === 'c-off' ? [REAL_TARGET, SCRIPTED_TARGET] : [REAL_TARGET]));
    expect(build(transcripts).model).toBe('fake');
    expect(build(transcripts, { model: 'real' }).model).toBe('fake');
  });

  it('an undeclared target gives unknown', () => {
    expect(build(transcriptsBy((caseId) => (caseId === 'b-on' ? [UNDECLARED_TARGET] : [REAL_TARGET]))).model).toBe('unknown');
  });

  it('a transcript without answeredBy gives unknown', () => {
    expect(build(transcriptsBy((caseId) => (caseId === 'a-on' ? undefined : [REAL_TARGET]))).model).toBe('unknown');
  });

  it('meaningless follows the computed kind', () => {
    expect(build(transcriptsBy(() => [SCRIPTED_TARGET]), { model: 'real' }).meaningless).toEqual([...MODEL_DEPENDENT_METRICS]);
    expect(build(transcriptsBy(() => [REAL_TARGET]), { model: 'fake' }).meaningless).toEqual([]);
  });

  it('an encoded report with the unknown kind parses back', () => {
    const report = build(transcriptsBy(() => [UNDECLARED_TARGET]));
    expect(parseContextReport(encodeContextReport(report), 'r.json').model).toBe('unknown');
  });
});

describe('real_model is a derived fact', () => {
  const real = (failingOn: readonly string[] = []) => build(transcriptsBy(() => [REAL_TARGET], failingOn));

  it('both reports answered by declared models of the same targets pass', () => {
    expect(realModelCheck(real(['a', 'b']), real())?.passed).toBe(true);
  });

  it('a report built from scripted transcripts cannot pass real_model however it is labelled', () => {
    const scripted = { ...build(transcriptsBy(() => [SCRIPTED_TARGET])), model: 'real' } as ContextReport;
    const check = realModelCheck(real(['a']), scripted);
    expect(check?.passed).toBe(false);
    expect(check?.detail).toMatch(/scripted/);
  });

  it('an undeclared target fails real_model with a message naming the target and the setting', () => {
    const check = realModelCheck(real(['a']), build(transcriptsBy(() => [UNDECLARED_TARGET])));
    expect(check?.passed).toBe(false);
    expect(check?.detail).toContain('local-llama');
    expect(check?.detail).toMatch(/answers/);
  });

  it('two reports answered by different targets fail the identity part, naming both', () => {
    const other = build(transcriptsBy(() => [OTHER_REAL_TARGET]));
    const check = realModelCheck(real(['a']), other);
    expect(other.model).toBe('real');
    expect(check?.passed).toBe(false);
    expect(check?.detail).toContain('opus');
    expect(check?.detail).toContain('sonnet');
  });

  it('an unknown answerer fails real_model, and the detail renders it without inventing an adapter or a model', () => {
    const check = realModelCheck(real(['a']), build(transcriptsBy(() => [REAL_TARGET, UNKNOWN_ANSWERER])));
    expect(check?.passed).toBe(false);
    expect(check?.detail).toMatch(/unknown/);
    expect(check?.detail).not.toMatch(/undefined/);
  });
});
