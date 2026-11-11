import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { INDICATOR_DEFINITIONS_VERSION } from '@momonga/protocol';
import type { RunFactsView } from '@momonga/protocol';
import { buildBenchmarkReport, parseBenchmark } from '@momonga/eval';
import { decodeReliabilityReport, encodeReliabilityReport, formatReliabilityReport } from '@momonga/reliability';
import { ADD_FIXED, benchmarkDir } from './bench-fixtures.ts';

const CREATED_AT = 1_800_000_000_000;

const NO_ROUND = { rounds: 0, firstRoundPassed: null, failedRounds: 0, checkMs: 0, fixRoundTokens: 0 };
const PASSED_ROUND = { rounds: 1, firstRoundPassed: true, failedRounds: 0, checkMs: 10, fixRoundTokens: 0 };
const FAILED_ROUND = { rounds: 1, firstRoundPassed: false, failedRounds: 1, checkMs: 10, fixRoundTokens: 0 };

const factsOf = (runId: string, overrides: Partial<RunFactsView>): RunFactsView => ({
  runId,
  rootRunId: runId,
  sessionId: `s-${runId}`,
  definitionsVersion: INDICATOR_DEFINITIONS_VERSION,
  model: 'fm',
  mode: 'acceptEdits',
  agent: 'build',
  origin: 'eval',
  status: 'COMPLETED',
  createdAt: CREATED_AT,
  endedAt: CREATED_AT + 1000,
  elapsedMs: 1000,
  humanWaitMs: 0,
  tokensTotal: 10,
  costNano: 0,
  steps: 1,
  limits: { maxSteps: 10, maxTotalTokens: 100000 },
  deadlineAt: CREATED_AT + 60000,
  asked: 0,
  elicited: 0,
  authorizationRequired: 0,
  sideEffectingCalls: 0,
  repeatedStarts: 0,
  reconciledAlreadyApplied: 0,
  reconciledNotApplied: 0,
  reconciledUnknown: 0,
  basis: { readOnly: 0, rule: 0, mode: 0, hook: 0, classifier: 0, person: 0 },
  answers: { allowOnce: 0, allowAlways: 0, rejectOnce: 0, rejectAlways: 0 },
  denials: { sandbox: 0, rule: 0, mode: 0, setting: 0, hook: 0, mandate: 0, superseded: 0, held: 0 },
  declared: true,
  met: true,
  mutated: true,
  owed: true,
  verification: NO_ROUND,
  recoveries: [],
  ...overrides,
});

const conditionsUnmet = { status: 'STOPPED', stopReason: 'conditions_unmet' } as const;

describe('the benchmark report prints the completion gate against the oracle (reliability design 3.2, verifiable completion M5)', () => {
  it('counts each trial in the 2x2 table of gate verdict and oracle verdict and prints it', async () => {
    const dir = await benchmarkDir([{ id: 'fix-add', reference: { 'src/add.js': ADD_FIXED } }]);
    const benchmark = parseBenchmark(fs.readFileSync(path.join(dir, 'benchmark.json'), 'utf8'), 'benchmark.json');
    const trial = (index: number, overrides: Partial<RunFactsView>) => ({ taskId: 'fix-add', trial: index, facts: factsOf(`t${index}`, overrides), children: [], costs: [{ runId: `t${index}`, calls: 0, notPriced: 0, legacyPrecisionCalls: 0, priced: [] }] });
    const report = buildBenchmarkReport({
      benchmark,
      trials: [
        trial(1, { verification: PASSED_ROUND, met: true }),
        trial(2, { verification: PASSED_ROUND, met: false }),
        trial(3, { ...conditionsUnmet, verification: FAILED_ROUND, met: true }),
        trial(4, { ...conditionsUnmet, verification: FAILED_ROUND, met: false }),
        trial(5, { ...conditionsUnmet, verification: FAILED_ROUND, met: false }),
        trial(6, { verification: NO_ROUND, met: true }),
      ],
      notRun: [],
      answeredBy: [{ target: 'fm', adapter: 'fm', upstreamModel: 'fm-1', answers: 'model' }],
      unrecordedAnswers: 0,
      codeDigest: 'c'.repeat(64),
      groupBy: 'model',
    });
    expect(report.gate).toEqual({ gatePassOraclePass: 1, gatePassOracleFail: 1, gateFailOraclePass: 1, gateFailOracleFail: 2, gateNotRun: 1 });
    expect(formatReliabilityReport(report)).toContain(
      'Completion gate against the oracle: passed with the oracle met 1, passed with the oracle unmet 1 (false pass), failed with the oracle met 1, failed with the oracle unmet 2, no gate verdict 1',
    );
    expect(decodeReliabilityReport(encodeReliabilityReport(report))).toEqual(report);
  });
});
