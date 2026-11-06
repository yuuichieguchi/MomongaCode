import { describe, expect, it } from 'vitest';
import { CONTEXT_DATASET_FORMAT, EvalError, compareContextReports, decodeTranscript, encodeTranscript, parseContextDataset } from '@momonga/eval';
import type { RecordedRun, Transcript } from '@momonga/eval';
import { answer, contextCase, recorded } from './context-fixtures.ts';
import { publicEventsOf } from './fixtures.ts';
import { buildReportAs } from './answered-fixtures.ts';

const dataset = parseContextDataset(
  JSON.stringify({ format: CONTEXT_DATASET_FORMAT, name: 'golden', cases: [contextCase('a-on', 'a', 'on'), contextCase('a-off', 'a', 'off')] }),
  'golden.json',
);

const goldenRun = (caseId: string): RecordedRun => ({
  caseId,
  runIndex: 0,
  run: { id: `run-${caseId}`, status: 'COMPLETED', step: 1, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
  events: publicEventsOf([{ type: 'run.started', attempt: 1, now: 0, pins: {} }, answer('done')]),
  children: [],
});

const unknownIdentity = { policy: null, codeDigest: null };

const goldenTranscripts = (): Transcript[] => [goldenRun('a-on'), goldenRun('a-off')].map((run): Transcript => ({ ...run, ...unknownIdentity }));

const liveReport = () => buildReportAs({ dataset, transcripts: [recorded('a-on', 0, []), recorded('a-off', 0, [])], model: 'real', seed: 1 });

describe('a golden recording carries the identity it knows, which is none', () => {
  it('round-trips a transcript whose policy and code digest are recorded as unknown', () => {
    const decoded = decodeTranscript(encodeTranscript({ ...goldenRun('a-on'), ...unknownIdentity }), 'golden.jsonl');
    expect(decoded.policy).toBeNull();
    expect(decoded.codeDigest).toBeNull();
  });

  it('refuses a transcript that records a policy with an unknown code digest, or the reverse', () => {
    const header = (extra: Record<string, unknown>): string => {
      const [first, ...rest] = encodeTranscript({ ...goldenRun('a-on'), ...unknownIdentity }).split('\n');
      return [JSON.stringify({ ...JSON.parse(first ?? ''), ...extra }), ...rest].join('\n');
    };
    expect(() => decodeTranscript(header({ policy: {}, codeDigest: null }), 'golden.jsonl')).toThrow(/both null or both recorded/);
    expect(() => decodeTranscript(header({ policy: null, codeDigest: 'd'.repeat(64) }), 'golden.jsonl')).toThrow(/both null or both recorded/);
  });

  it('builds a report that states its identity as unknown, inventing no empty policy', () => {
    const report = buildReportAs({ dataset, transcripts: goldenTranscripts(), model: 'real', seed: 1 });
    expect(report.policy).toBeNull();
    expect(report.codeDigest).toBeNull();
  });

  it('refuses a report that mixes transcripts of known and unknown identity', () => {
    const mixed = [recorded('a-on', 0, []), { ...goldenRun('a-off'), ...unknownIdentity }];
    expect(() => buildReportAs({ dataset, transcripts: mixed, model: 'real', seed: 1 })).toThrow(/known and unknown identity/);
  });

  it('refuses compare --gate token on a baseline of unknown identity, naming why', () => {
    const unknown = buildReportAs({ dataset, transcripts: goldenTranscripts(), model: 'real', seed: 1 });
    expect(() => compareContextReports(unknown, liveReport(), { seed: 1, gate: 'token' })).toThrow(EvalError);
    expect(() => compareContextReports(unknown, liveReport(), { seed: 1, gate: 'token' })).toThrow(/baseline report states its policy and code digest as unknown/);
  });

  it('refuses compare --gate token on a candidate of unknown identity, naming why', () => {
    const unknown = buildReportAs({ dataset, transcripts: goldenTranscripts(), model: 'real', seed: 1 });
    expect(() => compareContextReports(liveReport(), unknown, { seed: 1, gate: 'token' })).toThrow(/candidate report states its policy and code digest as unknown/);
  });

  it('still lets the context gate compare reports of unknown identity', () => {
    const unknown = buildReportAs({ dataset, transcripts: goldenTranscripts(), model: 'real', seed: 1 });
    expect(() => compareContextReports(unknown, unknown, { seed: 1, gate: 'context' })).not.toThrow();
  });
});
