import { describe, expect, it } from 'vitest';
import type { RuleVerdict } from '@momonga/protocol';
import { START_MS, harness, rawDb } from './helpers.ts';

const proved: RuleVerdict = { verdict: 'proved', solver: 'Z3 4.13', refuted: [], unknown: [], notProved: ['shell commands'] };
const refuted: RuleVerdict = { ...proved, verdict: 'refuted', refuted: [{ property: 'deny-precedence', subject: 'Read', message: 'a hole' }] };

describe('store.ruleVerdicts', () => {
  it('has no verdict for a fingerprint nobody stored', () => {
    expect(harness().store.ruleVerdicts.get('f'.repeat(64))).toBeUndefined();
  });

  it('stores one verdict per fingerprint with its solver version and time, and the first one stays', () => {
    const { store, clock } = harness();
    store.ruleVerdicts.put('a'.repeat(64), proved);
    clock.advance(5);
    store.ruleVerdicts.put('a'.repeat(64), refuted);
    store.ruleVerdicts.put('b'.repeat(64), refuted);
    expect(store.ruleVerdicts.get('a'.repeat(64))).toEqual({ fingerprint: 'a'.repeat(64), verdict: proved, createdAt: START_MS });
    expect(store.ruleVerdicts.get('b'.repeat(64))).toEqual({ fingerprint: 'b'.repeat(64), verdict: refuted, createdAt: START_MS + 5 });
  });

  it('replaces a stored unknown by a later proved or refuted verdict, and never a proved or refuted one', () => {
    const { store, clock } = harness();
    const undecided: RuleVerdict = { ...proved, verdict: 'unknown', unknown: [{ property: 'verification', reason: 'the verification budget of 60000 ms was spent' }] };
    store.ruleVerdicts.put('a'.repeat(64), undecided);
    clock.advance(5);
    store.ruleVerdicts.put('a'.repeat(64), { ...undecided, solver: 'other' });
    expect(store.ruleVerdicts.get('a'.repeat(64))).toEqual({ fingerprint: 'a'.repeat(64), verdict: undecided, createdAt: START_MS });
    store.ruleVerdicts.put('a'.repeat(64), proved);
    expect(store.ruleVerdicts.get('a'.repeat(64))).toEqual({ fingerprint: 'a'.repeat(64), verdict: proved, createdAt: START_MS + 5 });
    store.ruleVerdicts.put('a'.repeat(64), undecided);
    store.ruleVerdicts.put('a'.repeat(64), refuted);
    expect(store.ruleVerdicts.get('a'.repeat(64))?.verdict).toEqual(proved);
  });

  it('writes the solver version column from the verdict', () => {
    const { store, dbPath } = harness();
    store.ruleVerdicts.put('a'.repeat(64), proved);
    expect(rawDb(dbPath).prepare('SELECT solver_version FROM rule_verdicts').all()).toEqual([{ solver_version: 'Z3 4.13' }]);
  });

  it('reports a stored verdict that is not a verdict as corrupt', () => {
    const { store, dbPath } = harness();
    store.ruleVerdicts.put('a'.repeat(64), proved);
    rawDb(dbPath).prepare("UPDATE rule_verdicts SET verdict_json = '{}'").run();
    expect(() => store.ruleVerdicts.get('a'.repeat(64))).toThrow(/rule_verdicts/);
  });
});
