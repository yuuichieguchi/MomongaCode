import { INDICATOR_DEFINITIONS_VERSION } from '@momonga/protocol';
import type { RunFactsView } from '@momonga/protocol';
import { describe, expect, it } from 'vitest';
import { verifyFacts } from '../src/verify.ts';

const T0 = 1_800_000_000_000;

const row = (runId: string, overrides: Partial<RunFactsView> = {}): RunFactsView => ({
  runId,
  rootRunId: runId,
  sessionId: 'sess',
  definitionsVersion: INDICATOR_DEFINITIONS_VERSION,
  model: 'apple/fm',
  mode: 'manual',
  agent: 'build',
  origin: 'cli',
  status: 'COMPLETED',
  createdAt: T0,
  endedAt: T0 + 10,
  elapsedMs: 10,
  humanWaitMs: 0,
  tokensTotal: 0,
  costNano: 0,
  steps: 1,
  limits: {},
  asked: 0,
  elicited: 0,
  authorizationRequired: 0,
  sideEffectingCalls: 0,
  repeatedStarts: 0,
  reconciledAlreadyApplied: 0,
  reconciledNotApplied: 0,
  reconciledUnknown: 0,
  mutated: false,
  owed: false,
  verification: { rounds: 0, firstRoundPassed: null, failedRounds: 0, checkMs: 0, fixRoundTokens: 0 },
  answers: { allowOnce: 0, allowAlways: 0, rejectOnce: 0, rejectAlways: 0 },
  denials: { sandbox: 0, rule: 0, mode: 0, setting: 0, hook: 0, mandate: 0, superseded: 0, held: 0 },
  basis: { readOnly: 0, rule: 0, mode: 0, hook: 0, classifier: 0, person: 0 },
  declared: true,
  met: true,
  recoveries: [],
  ...overrides,
});

describe('verifyFacts: the stored facts against the fold of the journal', () => {
  it('agrees with stored facts that equal the fold', () => {
    const stored = [row('run-a'), row('run-b', { recoveries: [] })];
    expect(verifyFacts(stored, { rows: [row('run-b'), row('run-a')], refused: [] })).toEqual({ checked: 2, stale: [], refused: [], mismatches: [] });
  });

  it('fails on a changed fact and names every field that differs', () => {
    const stored = [row('run-a', { asked: 2, limits: { maxSteps: 3 } }), row('run-b')];
    expect(verifyFacts(stored, { rows: [row('run-a'), row('run-b')], refused: [] }).mismatches).toEqual([{ runId: 'run-a', fields: ['asked', 'limits'] }]);
  });

  it('names a field present on one side only', () => {
    const stored = [row('run-a', { deadlineAt: T0 + 5 })];
    expect(verifyFacts(stored, { rows: [row('run-a')], refused: [] }).mismatches).toEqual([{ runId: 'run-a', fields: ['deadlineAt'] }]);
  });

  it('lists a stored row of an older definitions version as stale, and a run the journal refused as refused, and compares neither', () => {
    const stored = [row('run-old', { definitionsVersion: INDICATOR_DEFINITIONS_VERSION - 1, asked: 9 }), row('run-gone')];
    expect(verifyFacts(stored, { rows: [row('run-old')], refused: ['run-gone'] })).toEqual({ checked: 0, stale: ['run-old'], refused: ['run-gone'], mismatches: [] });
  });

  it('refuses an answer that neither recomputes nor refuses a stored run', () => {
    expect(() => verifyFacts([row('run-a')], { rows: [], refused: [] })).toThrow(/run-a/);
  });
});
