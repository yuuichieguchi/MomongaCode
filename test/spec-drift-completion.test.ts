import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONDITION_WHENS, EVENT_TYPES, STOP_REASONS, completionMutates, conditionOwed, reconciliationMutates } from '@momonga/protocol';
import { WORKER_TRANSITIONS } from '@momonga/store';
import { cfgNames } from './formal/cfg-names.ts';
import { readManifest } from './formal/manifest.ts';

const tlaDir = path.resolve(import.meta.dirname, '..', 'specs', 'tla');
const gate = fs.readFileSync(path.join(tlaDir, 'CompletionGate.tla'), 'utf8');
const recovery = fs.readFileSync(path.join(tlaDir, 'RunRecovery.tla'), 'utf8');
const manifest = readManifest(path.join(tlaDir, 'manifest.json'));

const definitionIn = (spec: string, name: string): string => {
  const start = spec.search(new RegExp(`^${name}(\\([^)]*\\))? ==`, 'm'));
  if (start === -1) throw new Error(`${name} is not defined`);
  const end = spec.indexOf('\n\n', start);
  return spec.slice(start, end === -1 ? undefined : end);
};

const stringsIn = (text: string): string[] => [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);

const constantsOf = (name: string): Readonly<Record<string, string>> => cfgNames(tlaDir, name).constants;

const listedIn = (name: string, section: 'INVARIANTS' | 'PROPERTIES'): readonly string[] => (section === 'INVARIANTS' ? cfgNames(tlaDir, name).invariants : cfgNames(tlaDir, name).properties);

const gateEntries = manifest.entries.filter((entry) => entry.config.split('.')[0] === 'CompletionGate');

const SWITCHES = ['ModelEvidence', 'StaleKept', 'CountStarted', 'RerunNoMutation', 'LateUncounted'] as const;

describe('CompletionGate.tla against the tables of the code, in both directions', () => {
  it('names the stop reason the code stops an unmet completion with', () => {
    const [reason] = stringsIn(definitionIn(gate, 'StopReasonUnmet'));
    expect(STOP_REASONS as readonly string[]).toContain(reason);
    expect(reason).toBe('conditions_unmet');
  });

  it('names exactly the verification events of the protocol', () => {
    const modelled = [...stringsIn(definitionIn(gate, 'StartedEvent')), ...stringsIn(definitionIn(gate, 'CompletedEvent'))].sort();
    expect(modelled).toEqual(EVENT_TYPES.filter((type) => type.startsWith('verification.')).sort());
  });

  it('names exactly the values of when the code declares', () => {
    expect(stringsIn(definitionIn(gate, 'WhenValues')).sort()).toEqual([...CONDITION_WHENS].sort());
  });

  it('counts a mutation as the fold of the code does: the cases of the model through completionMutates and reconciliationMutates', () => {
    const write = { sideEffect: 'write' as const, rejected: false };
    const readOnly = { sideEffect: 'read_only' as const, rejected: false };
    expect(completionMutates(write, {})).toBe(true);
    expect(completionMutates(readOnly, {})).toBe(false);
    expect(completionMutates(readOnly, { mutated: true })).toBe(true);
    const mutating = stringsIn(definitionIn(gate, 'MutatingReconciled')).sort();
    for (const outcome of ['already_applied', 'not_applied', 'unknown'] as const) expect(reconciliationMutates(write, outcome), outcome).toBe(mutating.includes(outcome));
  });

  it('owes a condition as conditionOwed does: required by always or a mutation, and settled only by a pass at the current mutation', () => {
    const cases: { model: string; when: 'always' | 'after_mutation'; lastMutation: number; result?: { outcome: 'passed' | 'failed'; mutationSeq: number }; owed: boolean }[] = [
      { model: 'always, nothing changed, no result', when: 'always', lastMutation: 0, owed: true },
      { model: 'after_mutation, nothing changed', when: 'after_mutation', lastMutation: 0, owed: false },
      { model: 'after_mutation, changed, no result', when: 'after_mutation', lastMutation: 3, owed: true },
      { model: 'pass at the current mutation', when: 'after_mutation', lastMutation: 3, result: { outcome: 'passed', mutationSeq: 3 }, owed: false },
      { model: 'pass before a later mutation (StaleResultNotKept)', when: 'after_mutation', lastMutation: 5, result: { outcome: 'passed', mutationSeq: 3 }, owed: true },
      { model: 'failure at the current mutation', when: 'always', lastMutation: 3, result: { outcome: 'failed', mutationSeq: 3 }, owed: true },
    ];
    for (const { model, when, lastMutation, result, owed } of cases) {
      expect(conditionOwed({ when }, lastMutation, result === undefined ? undefined : { seq: 1, ...result }), model).toBe(owed);
    }
  });

  it('needs no new edge: the worker may move a running run to COMPLETED, to STOPPED and back to QUEUED', () => {
    for (const status of ['COMPLETED', 'STOPPED', 'QUEUED'] as const) expect(WORKER_TRANSITIONS.RUNNING).toContain(status);
  });
});

describe('the configurations of CompletionGate', () => {
  const evidence: Record<string, { switch: (typeof SWITCHES)[number]; violates: string }> = {
    'CompletionGate.modelEvidence': { switch: 'ModelEvidence', violates: 'CompletionNeedsCheck' },
    'CompletionGate.staleKept': { switch: 'StaleKept', violates: 'StaleResultNotKept' },
    'CompletionGate.startedCounts': { switch: 'CountStarted', violates: 'StartedNotCounted' },
    'CompletionGate.rerunNoMutation': { switch: 'RerunNoMutation', violates: 'RerunNeedsMutation' },
    'CompletionGate.lateMutationUncounted': { switch: 'LateUncounted', violates: 'CompletionNeedsCheck' },
  };

  it('lists the check configurations and one evidence configuration per switch', () => {
    expect(gateEntries.filter((entry) => entry.role === 'check').map((entry) => entry.config).sort()).toEqual(['CompletionGate', 'CompletionGate.hooks', 'CompletionGate.live', 'CompletionGate.undeclared']);
    expect(gateEntries.filter((entry) => entry.role === 'evidence').map((entry) => entry.config).sort()).toEqual(Object.keys(evidence).sort());
  });

  it('turns every switch off in the check configurations, and declares no check in exactly one of them', () => {
    for (const entry of gateEntries.filter((item) => item.role === 'check')) {
      for (const name of SWITCHES) expect(constantsOf(entry.config)[name], `${entry.config} ${name}`).toBe('FALSE');
    }
    expect(gateEntries.filter((entry) => constantsOf(entry.config)['CheckDeclared'] === 'FALSE').map((entry) => entry.config)).toEqual(['CompletionGate.undeclared']);
  });

  it('turns exactly one switch on in each evidence configuration and checks only the property it must violate', () => {
    for (const entry of gateEntries.filter((item) => item.role === 'evidence')) {
      const expected = evidence[entry.config];
      if (expected === undefined) throw new Error(`${entry.config} is not an expected evidence configuration`);
      const constants = constantsOf(entry.config);
      expect(SWITCHES.filter((name) => constants[name] === 'TRUE'), entry.config).toEqual([expected.switch]);
      expect(listedIn(entry.config, 'INVARIANTS'), entry.config).toEqual([expected.violates]);
      expect(entry.expect, entry.config).toEqual({ violates: expected.violates, exitCode: 12 });
    }
  });

  it('checks every invariant in the safety configurations and the liveness with -lncheck final', () => {
    const invariants = ['TypeOK', 'CompletionNeedsCheck', 'UnverifiedOnlyWithoutCheck', 'StaleResultNotKept', 'StoppedHasWitness', 'StartedNotCounted', 'RerunNeedsMutation', 'DeclarationImmutable'];
    for (const name of ['CompletionGate', 'CompletionGate.hooks', 'CompletionGate.undeclared']) expect(listedIn(name, 'INVARIANTS'), name).toEqual(invariants);
    expect(listedIn('CompletionGate.live', 'PROPERTIES')).toEqual(['Terminates']);
    expect(gateEntries.find((entry) => entry.config === 'CompletionGate.live')?.args).toEqual(['-lncheck', 'final']);
  });
});

describe('RunRecovery.tla and the completion check', () => {
  it('sends a response without tool calls to the completion check instead of leaving COMPLETED from Decide', () => {
    const decide = definitionIn(recovery, 'Decide');
    expect(decide).toMatch(/kind = "none"\s+THEN PcOnly\(w, "verifyLock"\)/);
    expect(decide).not.toMatch(/Leave\(w, "COMPLETED"\)/);
  });

  it('routes the worker through every pc of the check and checks its invariants in the RunRecovery check configurations with an invariant section', () => {
    const step = definitionIn(recovery, 'Step');
    for (const name of ['VerifyLock', 'VerifyReap', 'VerifyStart', 'VerifyCancel', 'VerifyKill', 'VerifyAbort', 'VerifyDone', 'CancelReap']) expect(step, name).toContain(`${name}(w)`);
    const checks = manifest.entries.filter((entry) => entry.config.split('.')[0] === 'RunRecovery' && entry.role === 'check' && listedIn(entry.config, 'INVARIANTS').length > 0);
    expect(checks.length).toBeGreaterThan(0);
    for (const entry of checks) for (const invariant of ['ExclusiveCheck', 'VerifyStartSeesStoppedCheck', 'CancelReapsCheck']) expect(listedIn(entry.config, 'INVARIANTS'), `${entry.config} ${invariant}`).toContain(invariant);
  });
});
