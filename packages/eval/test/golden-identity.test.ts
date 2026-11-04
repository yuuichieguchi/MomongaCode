import { describe, expect, it } from 'vitest';
import { EvalError, transcriptOfRecordedRun } from '@momonga/eval';
import type { PolicyOverlay, RecordedRun } from '@momonga/eval';
import type { PublicRunEvent } from '@momonga/protocol';
import { answer } from './context-fixtures.ts';
import { publicEventsOf } from './fixtures.ts';

const DAEMON_CODE = 'd'.repeat(64);
const DAEMON_POLICY: PolicyOverlay = { tools: { deferral: true } };

const runWith = (identity: { policy?: PolicyOverlay; codeDigest?: string }): RecordedRun => {
  const [started, ...rest] = publicEventsOf([{ type: 'run.started', attempt: 1, now: 0, pins: {} }, answer('done')]);
  if (started === undefined) throw new Error('no run.started');
  const events: PublicRunEvent[] = [{ ...started, ...identity } as PublicRunEvent, ...rest];
  return {
    caseId: 'golden-1',
    runIndex: 0,
    run: { id: 'run-golden-1-0', status: 'COMPLETED', step: 1, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    events,
    children: [],
  };
};

describe('eval run --record takes the identity of the run from its journal', () => {
  it('records the policy and the code digest that the run recorded when it started', () => {
    const transcript = transcriptOfRecordedRun(runWith({ policy: DAEMON_POLICY, codeDigest: DAEMON_CODE }));
    expect(transcript.policy).toEqual(DAEMON_POLICY);
    expect(transcript.codeDigest).toBe(DAEMON_CODE);
    expect(transcript.caseId).toBe('golden-1');
  });

  it('refuses a run whose journal records no identity instead of inventing an empty policy', () => {
    expect(() => transcriptOfRecordedRun(runWith({}))).toThrow(EvalError);
    expect(() => transcriptOfRecordedRun(runWith({ codeDigest: DAEMON_CODE }))).toThrow(/policy/);
    expect(() => transcriptOfRecordedRun(runWith({ policy: DAEMON_POLICY }))).toThrow(/codeDigest/);
  });
});