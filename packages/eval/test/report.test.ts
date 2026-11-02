import { describe, expect, it } from 'vitest';
import { DATASET_FORMAT, EvalError, decodeTranscript, encodeTranscript, formatReport, proportionOf, replayDataset } from '@momonga/eval';
import type { GoldenDataset, Transcript } from '@momonga/eval';
import { approvalTranscript, finalAnswerTranscript, goldenCase, toolRoundTripTranscript } from './fixtures.ts';

const dataset = (...cases: GoldenDataset['cases']): GoldenDataset => ({ format: DATASET_FORMAT, name: 'unit', cases });

describe('proportionOf', () => {
  it('reports the Wilson interval', () => {
    const half = proportionOf(5, 10);
    expect(half.rate).toBe(0.5);
    expect(half.low).toBeCloseTo(0.2366, 3);
    expect(half.high).toBeCloseTo(0.7634, 3);
    expect(proportionOf(10, 10).high).toBeCloseTo(1, 12);
    expect(proportionOf(0, 10).low).toBeCloseTo(0, 12);
  });

  it('rejects an impossible proportion and an empty one', () => {
    expect(() => proportionOf(3, 2)).toThrow(RangeError);
    expect(() => proportionOf(0, 0)).toThrow(RangeError);
  });
});

describe('transcript codec', () => {
  it('round-trips a transcript through JSONL', () => {
    const original = toolRoundTripTranscript('c1', 2);
    expect(decodeTranscript(encodeTranscript(original), 'c1.jsonl')).toEqual(original);
  });

  it('names the line of an event that is not a public run event', () => {
    const lines = encodeTranscript(finalAnswerTranscript('c1', 0)).split('\n');
    lines[2] = JSON.stringify({ type: 'nonsense' });
    expect(() => decodeTranscript(lines.join('\n'), 'bad.jsonl')).toThrow(/bad\.jsonl:3: not a public run event/);
  });

  it('rejects a file without a transcript header', () => {
    expect(() => decodeTranscript('{"type":"user.message"}\n', 'bad.jsonl')).toThrow(/first line must be a momonga-transcript\/1 header/);
  });
});

describe('replayDataset', () => {
  const answer = goldenCase({ id: 'answer', runs: 4, minPassRate: 0.5, graders: [{ kind: 'finalTextEquals', text: 'hi' }] });

  it('computes pass rates from recorded transcripts and gates on minPassRate', () => {
    const wrong = (runIndex: number): Transcript => {
      const transcript = finalAnswerTranscript('answer', runIndex);
      return { ...transcript, events: transcript.events.filter((event) => event.type !== 'model.responded') };
    };
    const passing = replayDataset(dataset(answer), [0, 1, 2, 3].map((index) => (index < 2 ? finalAnswerTranscript('answer', index) : wrong(index))));
    expect(passing.cases[0]?.passRate).toMatchObject({ successes: 2, trials: 4, rate: 0.5 });
    expect(passing.passed).toBe(true);
    const failing = replayDataset(dataset(answer), [0, 1, 2, 3].map((index) => (index < 1 ? finalAnswerTranscript('answer', index) : wrong(index))));
    expect(failing.passed).toBe(false);
    expect(formatReport(failing)).toMatch(/FAIL answer: pass rate 1\/4 = 25\.0%/);
    expect(formatReport(failing)).toMatch(/run 1 \(run-answer-1\) finalTextEquals: the run produced no model response/);
  });

  it('refuses a recording whose size differs from the case runs or that names an unknown case', () => {
    expect(() => replayDataset(dataset(answer), [finalAnswerTranscript('answer', 0)])).toThrow(EvalError);
    expect(() => replayDataset(dataset(answer), [...[0, 1, 2, 3].map((index) => finalAnswerTranscript('answer', index)), finalAnswerTranscript('other', 0)])).toThrow(/unknown case other/);
  });

  it('measures the false-allow and false-block rates over labelled permission decisions', () => {
    const askBash = goldenCase({ id: 'ask-bash', graders: [{ kind: 'permissionDecision', tool: 'Bash', expected: 'ask' }] });
    const askRead = goldenCase({ id: 'ask-read', graders: [{ kind: 'permissionDecision', tool: 'Read', expected: 'ask' }] });
    const allowBash = goldenCase({ id: 'allow-bash', graders: [{ kind: 'permissionDecision', tool: 'Bash', expected: 'allow' }] });
    const report = replayDataset(dataset(askBash, askRead, allowBash), [
      approvalTranscript('ask-bash', 0),
      toolRoundTripTranscript('ask-read', 0),
      approvalTranscript('allow-bash', 0),
    ]);
    expect(report.decisions.falseAllow).toMatchObject({ successes: 1, trials: 2, rate: 0.5 });
    expect(report.decisions.falseBlock).toMatchObject({ successes: 1, trials: 1, rate: 1 });
    expect(report.decisions.unobserved).toBe(0);
    expect(formatReport(report)).toMatch(/false-allow rate 1\/2 = 50\.0%/);
  });

  it('keeps an unobserved decision out of the rates and counts it', () => {
    const askWrite = goldenCase({ id: 'ask-write', graders: [{ kind: 'permissionDecision', tool: 'Write', expected: 'ask' }] });
    const report = replayDataset(dataset(askWrite), [finalAnswerTranscript('ask-write', 0)]);
    expect(report.decisions.falseAllow).toBeUndefined();
    expect(report.decisions.unobserved).toBe(1);
    expect(report.passed).toBe(false);
  });
});
