import { describe, expect, it } from 'vitest';
import type { RuleVerdict } from '@momonga/protocol';
import { START_MS, harness, rawDb } from './helpers.ts';

const proved: RuleVerdict = { verdict: 'proved', solver: 'Z3 4.13', refuted: [], unknown: [], notProved: ['shell commands'] };
const refuted: RuleVerdict = { ...proved, verdict: 'refuted', refuted: [{ property: 'secret-reach', subject: 'Read', message: 'a hole' }] };

describe('store.ruleVerdicts', () => {
  it('has no verdict for a fingerprint nobody stored', () => {
    expect(harness().store.ruleVerdicts.get('f'.repeat(64))).toBeUndefined();
  });

  it('stores one verdict per fingerprint with its solver version and time, and a later computed verdict replaces it', () => {
    const { store, clock } = harness();
    store.ruleVerdicts.put('a'.repeat(64), proved);
    store.ruleVerdicts.put('b'.repeat(64), refuted);
    clock.advance(5);
    store.ruleVerdicts.put('a'.repeat(64), refuted);
    expect(store.ruleVerdicts.get('a'.repeat(64))).toEqual({ fingerprint: 'a'.repeat(64), verdict: refuted, createdAt: START_MS + 5 });
    expect(store.ruleVerdicts.get('b'.repeat(64))).toEqual({ fingerprint: 'b'.repeat(64), verdict: refuted, createdAt: START_MS });
  });

  it.each(['unknown', 'failed', 'not-needed'] as const)('refuses to store a verdict of kind %s, which is not a final answer about the rules, and keeps what is stored', (kind) => {
    const { store } = harness();
    const undecided: RuleVerdict = { ...proved, verdict: kind, unknown: [{ property: 'verification', reason: 'the verification budget of 60000 ms was spent' }] };
    expect(() => store.ruleVerdicts.put('a'.repeat(64), undecided)).toThrow(`a rule verdict of kind ${kind} is not stored`);
    expect(store.ruleVerdicts.get('a'.repeat(64))).toBeUndefined();
    store.ruleVerdicts.put('a'.repeat(64), proved);
    expect(() => store.ruleVerdicts.put('a'.repeat(64), undecided)).toThrow();
    expect(store.ruleVerdicts.get('a'.repeat(64))?.verdict).toEqual(proved);
  });

  it('reads a row that an earlier version stored as unknown as no verdict, so that it is verified again', () => {
    const { store, dbPath } = harness();
    store.ruleVerdicts.put('a'.repeat(64), proved);
    rawDb(dbPath).prepare(`UPDATE rule_verdicts SET verdict_json = json_set(verdict_json, '$.verdict', 'unknown')`).run();
    expect(store.ruleVerdicts.get('a'.repeat(64))).toBeUndefined();
    store.ruleVerdicts.put('a'.repeat(64), refuted);
    expect(store.ruleVerdicts.get('a'.repeat(64))?.verdict).toEqual(refuted);
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
