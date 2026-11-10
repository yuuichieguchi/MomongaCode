import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RUN_LOCK_EXIT } from '../../scripts/support/run-lock.ts';
import { actionPropertyViolationOutput, completedOutput, holdsEntry, invariantEntry, invariantViolationOutput, runOf, temporalEntry, temporalViolationOutput } from './fixtures.ts';
import type { ManifestEntry, TlcRun } from './manifest.ts';
import { verdictProblems as verdictProblemsOfManifest } from './manifest.ts';
import { factsOf, problemsOf, SCRIPT_FAILURE_CODES, verdictProblems } from './verdict.ts';

const FETCH_COMMAND = 'curl -L -o .cache/tla/tla2tools.jar https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar';

const factCases: readonly (readonly [string, ManifestEntry, TlcRun])[] = [
  ['a holding run with exit 0, the completion line and the exact distinct states', holdsEntry, runOf(0, completedOutput(3))],
  ['a holding entry when TLC exits with a violation code', holdsEntry, runOf(12, invariantViolationOutput('Small'))],
  ['a holding entry when the distinct states differ from the record', holdsEntry, runOf(0, completedOutput(4))],
  ['a holding entry when exit 0 comes without the completion line', holdsEntry, runOf(0, '3 states generated, 3 distinct states found, 0 states left on queue.')],
  ['an invariant violation with the declared exit code and the named invariant', invariantEntry, runOf(12, invariantViolationOutput('Small'))],
  ['an expected violation when TLC exits 0', invariantEntry, runOf(0, completedOutput(3))],
  ['an expected violation when TLC exits with a different code', invariantEntry, runOf(13, invariantViolationOutput('Small'))],
  ['an expected violation when a different invariant is violated', invariantEntry, runOf(12, invariantViolationOutput('Other'))],
  ['a temporal violation with exit 13 and the temporal line', temporalEntry, runOf(13, temporalViolationOutput)],
  ['a temporal expectation when TLC exits 12', temporalEntry, runOf(12, temporalViolationOutput)],
  ['an action property violation with exit 13 and the named property', temporalEntry, runOf(13, actionPropertyViolationOutput('Settles'))],
  ['an action property violation that names another property', temporalEntry, runOf(13, actionPropertyViolationOutput('Other'))],
];

const LOCK_REFUSAL_CODES: readonly number[] = [RUN_LOCK_EXIT.refused, RUN_LOCK_EXIT.waitedOut, RUN_LOCK_EXIT.unusable];

const killedRun: TlcRun = { ...runOf(0, ''), exitCode: null, signal: 'SIGKILL', killedAtCpuBudget: true };

const scriptFailureCases: readonly (readonly [number, string])[] = [
  [3, `tla2tools.jar is missing\n  fetch: ${FETCH_COMMAND}\n`],
  [5, 'java.specification.version 1.8 or later is required; install a JDK on macOS or openjdk-17-jre-headless on Debian\n'],
];

describe('the facts of a TLC run and the verdict on them', () => {
  it.each(factCases)('judges the facts of %s exactly as the verdict on the run, without the output dump', (_label, entry, run) => {
    const whole = verdictProblems(entry, run);
    const expected = whole.length === 0 ? [] : whole.slice(0, -1);
    expect(problemsOf(entry, factsOf(run))).toEqual(expected);
  });

  it.each(factCases)('keeps the verdict of the manifest module on %s', (_label, entry, run) => {
    expect(verdictProblemsOfManifest(entry, run)).toEqual(verdictProblems(entry, run));
  });

  it('still fails a run killed at its budget with the budget text', () => {
    const problems = verdictProblems(holdsEntry, killedRun);
    expect(problems).not.toEqual([]);
    expect(problems[0]).toBe('Tiny was killed at its CPU budget of 5 CPU s');
  });

  it.each(scriptFailureCases)('still fails with the script stderr when the script exits %i', (code, stderr) => {
    const problems = verdictProblems(holdsEntry, runOf(code, '', stderr));
    expect(problems[0]).toBe(`Tiny: tlc.sh exited ${code}`);
    expect(problems.join('\n')).toContain(stderr.trim());
  });

  it('reads every fact of a violating run that printed several violations and a count', () => {
    const stdout = [
      'Error: Invariant A is violated.',
      'Error: Invariant B is violated.',
      'Error: Action property P is violated.',
      'Error: Temporal properties were violated.',
      '1,234 states generated, 1,200 distinct states found, 0 states left on queue.',
    ].join('\n');
    expect(factsOf(runOf(12, stdout))).toEqual({
      exitCode: 12,
      signal: null,
      completed: false,
      distinctStates: 1200,
      invariantsViolated: ['A', 'B'],
      actionPropertiesViolated: ['P'],
      temporalViolated: true,
    });
  });

  it('keeps the facts unchanged through JSON and reads no count from a violating run that printed none', () => {
    const counted = factsOf(runOf(0, completedOutput(3)));
    expect(JSON.parse(JSON.stringify(counted))).toEqual(counted);
    const violating = factsOf(runOf(12, invariantViolationOutput('Small')));
    expect(JSON.parse(JSON.stringify(violating))).toEqual(violating);
    expect(violating.distinctStates).toBeNull();
  });

  it.each(LOCK_REFUSAL_CODES)('reports exit %i as a failure of the script', (code) => {
    expect(verdictProblems(holdsEntry, runOf(code, '', ''))[0]).toBe(`Tiny: tlc.sh exited ${code}`);
  });

  it('lists every exit code by which the run lock refuses a run among the failures of the script', () => {
    expect(LOCK_REFUSAL_CODES).toHaveLength(3);
    expect(SCRIPT_FAILURE_CODES).toEqual(expect.arrayContaining([...LOCK_REFUSAL_CODES]));
  });

  it('writes none of the exit codes of the run lock as a number in the verdict module', () => {
    const source = fs.readFileSync(new URL('./verdict.ts', import.meta.url), 'utf8');
    const written = LOCK_REFUSAL_CODES.filter((code) => new RegExp(`(?<![\\w.])${code}(?![\\w.])`).test(source));
    expect(written).toEqual([]);
  });

  it.each([75, 76, 77])('reports exit %i as an evaluation failure of TLC', (code) => {
    expect(verdictProblems(holdsEntry, runOf(code, '', ''))[0]).toBe(`Tiny was expected to hold but TLC exited ${code}`);
  });
});
