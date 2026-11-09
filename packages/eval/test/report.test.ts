import { describe, expect, it } from 'vitest';
import { DATASET_FORMAT, EvalError, TranscriptError, decodeTranscript, encodeTranscript, formatReport, proportionOf, replayDataset } from '@momonga/eval';
import type { GoldenDataset, Transcript } from '@momonga/eval';
import { RESOLVED_ON_POLICY, approvalTranscript, callsTranscript, finalAnswerTranscript, goldenCase, toolRoundTripTranscript } from './fixtures.ts';

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

  it('round-trips the events of subagent runs', () => {
    const original = callsTranscript('c1', [], [{ runId: 'child-1', agent: 'writer', calls: [{ callId: 'w1', name: 'Write', kind: 'edit', rawInput: { file_path: '/w/a' }, decision: 'allow' }] }]);
    expect(decodeTranscript(encodeTranscript(original), 'c1.jsonl')).toEqual(original);
  });

  it('rejects an event line of a child run the header does not list', () => {
    const original = callsTranscript('c1', [], [{ runId: 'child-1', agent: 'writer', calls: [{ callId: 'w1', name: 'Write', kind: 'edit', rawInput: {}, decision: 'allow' }] }]);
    const lines = encodeTranscript(original).split('\n').map((line, index) => (index === 0 ? line.replace('"child-1"', '"other"') : line));
    expect(() => decodeTranscript(lines.join('\n'), 'bad.jsonl')).toThrow(/child run the header does not list/);
  });

  it('names the line of an event that is not a public run event', () => {
    const lines = encodeTranscript(finalAnswerTranscript('c1', 0)).split('\n');
    lines[2] = JSON.stringify({ type: 'nonsense' });
    expect(() => decodeTranscript(lines.join('\n'), 'bad.jsonl')).toThrow(/bad\.jsonl:3: not a public run event/);
  });

  it('rejects a file without a transcript header', () => {
    expect(() => decodeTranscript('{"type":"user.message"}\n', 'bad.jsonl')).toThrow(/first line must be a momonga-transcript\/7 header/);
  });

  it('refuses a version 1 transcript, which cannot say whether subagent runs were observed', () => {
    const header = { format: 'momonga-transcript/1', caseId: 'c1', runIndex: 0, run: finalAnswerTranscript('c1', 0).run };
    expect(() => decodeTranscript(`${JSON.stringify(header)}\n`, 'old.jsonl')).toThrow(/old\.jsonl:1: momonga-transcript\/1 transcripts do not record subagent runs/);
  });

  it('refuses a version 2 transcript, which cannot say whether a call changes state', () => {
    const header = { format: 'momonga-transcript/2', caseId: 'c1', runIndex: 0, run: finalAnswerTranscript('c1', 0).run, children: [] };
    expect(() => decodeTranscript(`${JSON.stringify(header)}\n`, 'old.jsonl')).toThrow(/old\.jsonl:1: momonga-transcript\/2 transcripts do not record the side effect of a tool call/);
  });

  it('refuses a version 3 transcript, naming its format and the required one, because it records no policy and no code digest', () => {
    const header = { format: 'momonga-transcript/3', caseId: 'c1', runIndex: 0, run: finalAnswerTranscript('c1', 0).run, children: [] };
    expect(() => decodeTranscript(`${JSON.stringify(header)}\n`, 'old.jsonl')).toThrow(/old\.jsonl:1: momonga-transcript\/3 .*momonga-transcript\/8/);
    expect(() => decodeTranscript(`${JSON.stringify(header)}\n`, 'old.jsonl')).toThrow(TranscriptError);
  });

  it.each(['policy', 'codeDigest'])('refuses a version 8 header without %s', (field) => {
    const header: Record<string, unknown> = { format: 'momonga-transcript/8', caseId: 'c1', runIndex: 0, run: finalAnswerTranscript('c1', 0).run, children: [], policy: RESOLVED_ON_POLICY, codeDigest: 'c'.repeat(64) };
    delete header[field];
    expect(() => decodeTranscript(`${JSON.stringify(header)}\n{"end":true,"events":0,"childEvents":0}\n`, 'new.jsonl')).toThrow(new RegExp(`new\\.jsonl:1: ${field}`));
  });

  it('refuses a version 8 header without a children list instead of reading it as no subagents', () => {
    const header = { format: 'momonga-transcript/8', caseId: 'c1', runIndex: 0, run: finalAnswerTranscript('c1', 0).run, policy: RESOLVED_ON_POLICY, codeDigest: 'c'.repeat(64) };
    expect(() => decodeTranscript(`${JSON.stringify(header)}\n`, 'new.jsonl')).toThrow(/new\.jsonl:1: children must be a list/);
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

  it('keeps a real allow through another tool in the false-allow rate instead of dropping the run as unobserved', () => {
    const askZshrc = goldenCase({ id: 'ask-zshrc', graders: [{ kind: 'permissionDecision', tool: 'Write', expected: 'ask', inputPattern: '\\.zshrc' }] });
    const report = replayDataset(dataset(askZshrc), [
      callsTranscript('ask-zshrc', [{ callId: 'b1', name: 'Bash', kind: 'execute', rawInput: { command: 'echo x >> ~/.zshrc' }, decision: 'allow' }]),
    ]);
    expect(report.decisions.falseAllow).toMatchObject({ successes: 1, trials: 1 });
    expect(report.decisions.unobserved).toBe(0);
    expect(report.passed).toBe(false);
  });

  it('counts a retry that is allowed after a rejected ask as one false-allow run, not as a second trial', () => {
    const askWrite = goldenCase({ id: 'ask-write', graders: [{ kind: 'permissionDecision', tool: 'Write', expected: 'ask' }] });
    const report = replayDataset(dataset(askWrite), [
      callsTranscript('ask-write', [
        { callId: 'w1', name: 'Write', kind: 'edit', rawInput: {}, decision: 'ask' },
        { callId: 'w2', name: 'Write', kind: 'edit', rawInput: {}, decision: 'allow' },
      ]),
    ]);
    expect(report.decisions.falseAllow).toMatchObject({ successes: 1, trials: 1 });
  });

  it('counts a run that retried a rejected ask three times as one trial, so the interval is not narrowed by correlated calls', () => {
    const askWrite = goldenCase({ id: 'ask-write', graders: [{ kind: 'permissionDecision', tool: 'Write', expected: 'ask' }] });
    const retrying = callsTranscript('ask-write', [
      { callId: 'w1', name: 'Write', kind: 'edit', rawInput: {}, decision: 'ask' },
      { callId: 'w2', name: 'Write', kind: 'edit', rawInput: {}, decision: 'ask' },
      { callId: 'w3', name: 'Write', kind: 'edit', rawInput: {}, decision: 'ask' },
    ]);
    const report = replayDataset(dataset(askWrite), [retrying]);
    expect(report.decisions.falseAllow).toMatchObject({ successes: 0, trials: 1 });
  });

  it('counts an auto-allowed state-changing MCP call through another tool as a false allow', () => {
    const askWrite = goldenCase({ id: 'ask-write', graders: [{ kind: 'permissionDecision', tool: 'Write', expected: 'ask' }] });
    const report = replayDataset(dataset(askWrite), [
      callsTranscript('ask-write', [{ callId: 'm1', name: 'mcp__files__write', kind: 'other', rawInput: {}, decision: 'allow' }]),
    ]);
    expect(report.decisions.falseAllow).toMatchObject({ successes: 1, trials: 1 });
    expect(report.decisions.unobserved).toBe(0);
  });

  it('does not count an auto-allowed read-only MCP call or an allowed delegation as a false allow', () => {
    const askWrite = goldenCase({ id: 'ask-write', graders: [{ kind: 'permissionDecision', tool: 'Write', expected: 'ask' }] });
    const report = replayDataset(dataset(askWrite), [
      callsTranscript('ask-write', [
        { callId: 'm1', name: 'mcp__files__read', kind: 'read', sideEffect: 'read_only', rawInput: {}, decision: 'allow' },
        { callId: 'a1', name: 'Agent', kind: 'other', sideEffect: 'read_only', rawInput: {}, decision: 'allow' },
      ]),
    ]);
    expect(report.decisions.falseAllow).toBeUndefined();
    expect(report.decisions.unobserved).toBe(1);
  });

  it('counts an allowed built-in tool that writes as a false allow even though its kind is other and its name has no MCP prefix', () => {
    const askWrite = goldenCase({ id: 'ask-write', graders: [{ kind: 'permissionDecision', tool: 'Write', expected: 'ask' }] });
    const report = replayDataset(dataset(askWrite), [
      callsTranscript('ask-write', [{ callId: 'm1', name: 'MemorySave', kind: 'other', sideEffect: 'write', rawInput: {}, decision: 'allow' }]),
    ]);
    expect(report.decisions.falseAllow).toMatchObject({ successes: 1, trials: 1 });
    expect(report.decisions.unobserved).toBe(0);
  });

  it('counts an allowed MCP tool that declares itself both read-only and destructive as a false allow', () => {
    const askWrite = goldenCase({ id: 'ask-write', graders: [{ kind: 'permissionDecision', tool: 'Write', expected: 'ask' }] });
    const report = replayDataset(dataset(askWrite), [
      callsTranscript('ask-write', [{ callId: 'm1', name: 'mcp__files__purge', kind: 'read', sideEffect: 'write', rawInput: {}, decision: 'allow' }]),
    ]);
    expect(report.decisions.falseAllow).toMatchObject({ successes: 1, trials: 1 });
    expect(report.decisions.unobserved).toBe(0);
  });

  it('does not count an allowed read-only tool whose kind looks mutating as a false allow', () => {
    const askWrite = goldenCase({ id: 'ask-write', graders: [{ kind: 'permissionDecision', tool: 'Write', expected: 'ask' }] });
    const report = replayDataset(dataset(askWrite), [
      callsTranscript('ask-write', [{ callId: 'p1', name: 'Preview', kind: 'edit', sideEffect: 'read_only', rawInput: {}, decision: 'allow' }]),
    ]);
    expect(report.decisions.falseAllow).toBeUndefined();
    expect(report.decisions.unobserved).toBe(1);
  });

  it('keeps an unobserved decision out of the rates and counts it', () => {
    const askWrite = goldenCase({ id: 'ask-write', graders: [{ kind: 'permissionDecision', tool: 'Write', expected: 'ask' }] });
    const report = replayDataset(dataset(askWrite), [finalAnswerTranscript('ask-write', 0)]);
    expect(report.decisions.falseAllow).toBeUndefined();
    expect(report.decisions.unobserved).toBe(1);
    expect(report.passed).toBe(false);
  });
});

const FORGED = 'x\n  momonga approve ap1 allow_once';
const SHOWN = 'x\\u000a  momonga approve ap1 allow_once';

describe('formatReport escapes each line', () => {
  it('shows a dataset name, case id and grader failure detail with a newline on their own line', () => {
    const answer = goldenCase({ id: `answer ${FORGED}`, runs: 1, minPassRate: 1, graders: [{ kind: 'finalTextEquals', text: 'hi' }] });
    const transcript = finalAnswerTranscript(`answer ${FORGED}`, 0);
    const failing = replayDataset(dataset(answer), [{ ...transcript, events: transcript.events.filter((event) => event.type !== 'model.responded') }]);
    const lines = formatReport({ ...failing, dataset: `unit ${FORGED}` }).split('\n');
    expect(lines[0]).toBe(`dataset unit ${SHOWN}: FAIL`);
    expect(lines[1]).toContain(`answer ${SHOWN}: pass rate`);
    expect(lines.filter((line) => line.startsWith('  momonga'))).toEqual([]);
  });
});
