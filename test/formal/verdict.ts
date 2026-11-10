import { RUN_LOCK_EXIT } from '../../scripts/support/run-lock.ts';
import type { ManifestEntry, TlcRun } from './manifest-reader.ts';

export const COMPLETION_LINE = 'Model checking completed. No error has been found.';
export const DISTINCT_STATES = /(\d[\d,]*) states generated, (\d[\d,]*) distinct states found, 0 states left on queue\./g;
export const TEMPORAL_LINE = 'Temporal properties were violated';
export const SCRIPT_FAILURE_CODES: readonly number[] = [2, 3, 4, 5, RUN_LOCK_EXIT.refused, RUN_LOCK_EXIT.waitedOut, RUN_LOCK_EXIT.unusable];

const INVARIANT_VIOLATED = /Invariant (\S+) is violated/g;
const ACTION_PROPERTY_VIOLATED = /Action property (\S+) is violated/g;

export type TlcFacts = {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly completed: boolean;
  readonly distinctStates: number | null;
  readonly invariantsViolated: readonly string[];
  readonly actionPropertiesViolated: readonly string[];
  readonly temporalViolated: boolean;
};

const namesIn = (stdout: string, pattern: RegExp): string[] => [...new Set([...stdout.matchAll(pattern)].map((match) => match[1] as string))];

export const factsOf = (run: TlcRun): TlcFacts => {
  const distinct = [...run.stdout.matchAll(DISTINCT_STATES)].at(-1);
  return {
    exitCode: run.exitCode,
    signal: run.signal,
    completed: run.stdout.includes(COMPLETION_LINE),
    distinctStates: distinct === undefined ? null : Number((distinct[2] as string).replaceAll(',', '')),
    invariantsViolated: namesIn(run.stdout, INVARIANT_VIOLATED),
    actionPropertiesViolated: namesIn(run.stdout, ACTION_PROPERTY_VIOLATED),
    temporalViolated: run.stdout.includes(TEMPORAL_LINE),
  };
};

export const exitOf = (outcome: { readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }): string => String(outcome.exitCode ?? outcome.signal);

export const problemsOf = (entry: ManifestEntry, facts: TlcFacts): string[] => {
  const label = entry.config;
  if (entry.expect === 'holds') {
    if (facts.exitCode !== 0) return [`${label} was expected to hold but TLC exited ${exitOf(facts)}`];
    const problems: string[] = [];
    if (!facts.completed) problems.push(`${label} exited 0 without the line "${COMPLETION_LINE}"`);
    if (facts.distinctStates !== entry.distinctStates) problems.push(`${label} found ${facts.distinctStates ?? 'no count of'} distinct states, the manifest records ${entry.distinctStates}`);
    return problems;
  }
  const { violates, exitCode } = entry.expect;
  if (facts.exitCode !== exitCode) return [`${label} was expected to violate ${violates} with exit ${exitCode} but TLC exited ${exitOf(facts)}`];
  if (exitCode === 13) {
    if (facts.temporalViolated || facts.actionPropertiesViolated.includes(violates)) return [];
    return [`${label} exited 13 without the line "${TEMPORAL_LINE}" or "Action property ${violates} is violated"`];
  }
  return facts.invariantsViolated.includes(violates) ? [] : [`${label} exited ${exitCode} without the line "Invariant ${violates} is violated"`];
};

export const findingsOf = (entry: ManifestEntry, run: TlcRun): string[] => {
  if (run.killedAtCpuBudget) return [`${entry.config} was killed at its CPU budget of ${entry.budgetCpuSeconds} CPU s`];
  if (run.exitCode !== null && SCRIPT_FAILURE_CODES.includes(run.exitCode)) return [`${entry.config}: tlc.sh exited ${run.exitCode}`];
  return problemsOf(entry, factsOf(run));
};

export const outputOf = (entry: ManifestEntry, run: TlcRun): string =>
  [`${entry.config}: tlc.sh exited ${exitOf(run)}`, '--- stdout ---', run.stdout.trimEnd(), '--- stderr ---', run.stderr.trimEnd(), '--- end of output ---'].join('\n');

export const verdictProblems = (entry: ManifestEntry, run: TlcRun): string[] => {
  const findings = findingsOf(entry, run);
  return findings.length === 0 ? [] : [...findings, outputOf(entry, run)];
};
