import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { INJECTION_FAULTS, buildInjectionReport, parseInjectionScenarios } from '@momonga/eval';
import { INDICATOR_DEFINITIONS_VERSION } from '@momonga/protocol';
import type { RunFactsView } from '@momonga/protocol';
import type { InjectionScenarios, InjectionTrial } from '@momonga/eval';

const SHIPPED = path.join(import.meta.dirname, '..', '..', '..', 'e2e', 'inject', 'scenarios.json');
const shipped = (): string => fs.readFileSync(SHIPPED, 'utf8');

const withScenario = (change: (scenario: Record<string, unknown>) => void): string => {
  const file = JSON.parse(shipped()) as { scenarios: Record<string, unknown>[] };
  change(file.scenarios[0] as Record<string, unknown>);
  return JSON.stringify(file);
};

describe('momonga-inject/1 (design 4.1)', () => {
  it('parses the shipped scenario set: ten faults, one needing the Linux container', () => {
    const parsed = parseInjectionScenarios(shipped(), SHIPPED);
    expect(new Set(parsed.scenarios.map((scenario) => scenario.fault))).toEqual(new Set(INJECTION_FAULTS));
    expect(parsed.scenarios.filter((scenario) => scenario.requires === 'linux-container')).toHaveLength(1);
  });

  it('refuses another format by name', () => {
    expect(() => parseInjectionScenarios(JSON.stringify({ format: 'momonga-inject/0', name: 'old', scenarios: [] }), 'old.json')).toThrow(/momonga-inject\/0/);
  });

  it('refuses a fault outside the fault table', () => {
    expect(() => parseInjectionScenarios(withScenario((scenario) => (scenario['fault'] = 'meteor')), 'bad.json')).toThrow(/invalid injection scenarios/);
  });

  it('refuses a fault whose parameter is missing', () => {
    expect(() => parseInjectionScenarios(withScenario((scenario) => delete scenario['params']), 'bad.json')).toThrow(/needs the parameter points/);
  });

  it('refuses a scenario whose steps do not end with a text reply', () => {
    expect(() => parseInjectionScenarios(withScenario((scenario) => ((scenario['task'] as { steps: unknown[] }).steps = [{ call: { name: 'Bash', input: {} } }])), 'bad.json')).toThrow(/end its steps with a text reply/);
  });

  it('refuses a duplicate scenario id', () => {
    const file = JSON.parse(shipped()) as { scenarios: unknown[] };
    file.scenarios.push(file.scenarios[0]);
    expect(() => parseInjectionScenarios(JSON.stringify(file), 'bad.json')).toThrow(/duplicate scenario id/);
  });
});

describe('the injection report builder (design 4.4)', () => {
  const scenarios: InjectionScenarios = parseInjectionScenarios(shipped(), SHIPPED);
  const answered = { target: 'primary', adapter: 'chat-completions', upstreamModel: 'system', answers: 'script' as const };

  let counter = 0;

  const trial = (scenario: string, witness: Record<string, number>, outcomes: ('recovered' | 'unknown_effect')[]): InjectionTrial => {
    counter += 1;
    const runId = `run-${counter}`;
    const facts: RunFactsView = {
      runId,
      rootRunId: runId,
      sessionId: 's',
      definitionsVersion: INDICATOR_DEFINITIONS_VERSION,
      model: 'default',
      mode: 'bypassPermissions',
      agent: 'main',
      origin: 'api',
      status: 'COMPLETED',
      createdAt: 1,
      endedAt: 2,
      elapsedMs: 1,
      humanWaitMs: 0,
      tokensTotal: 1,
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
      declared: false,
      met: false,
      recoveries: outcomes.map((outcome, index) => ({ ordinal: index + 1, cause: 'process_lost', failedAt: 1, progressAt: 2, outcome, startedSeq: 1, progressSeq: 2 })),
    };
    return { scenario, facts: [facts], witness, answeredBy: [answered], unrecordedAnswers: 0 };
  };

  it('counts episodes and recoveries per scenario row, the witnessed duplicates per trial, and carries the scenarios that were not run', () => {
    const report = buildInjectionReport({
      scenarios,
      trials: [
        trial('network-down', { 'effect-1': 1 }, ['recovered']),
        trial('network-down', { 'effect-1': 2 }, ['recovered']),
        trial('kill-at-step@tool.started#1', { 'step-1': 1 }, ['unknown_effect']),
        trial('budget-reached', {}, []),
      ],
      notRun: [{ id: 'disk-full', reason: 'linux-container: needs the container' }],
      codeDigest: 'digest',
      groupBy: 'model',
    });
    expect(report).toMatchObject({
      kind: 'injection',
      scenarios: [
        { scenario: 'network-down', trials: 2, episodes: 2, recovered: 2 },
        { scenario: 'kill-at-step@tool.started#1', trials: 1, episodes: 1, recovered: 0 },
        { scenario: 'budget-reached', trials: 1, episodes: 0, recovered: 0 },
      ],
      witnessed: { k: 1, n: 3 },
      population: { notRun: [{ id: 'disk-full', reason: 'linux-container: needs the container' }] },
      harness: { suite: { name: 'momonga-inject' }, codeDigest: 'digest', answeredBy: [answered] },
    });
  });

  it('refuses a trial of a scenario the file does not hold', () => {
    expect(() => buildInjectionReport({ scenarios, trials: [trial('meteor', {}, [])], notRun: [], codeDigest: 'd', groupBy: 'model' })).toThrow(/meteor/);
  });
});
