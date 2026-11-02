import { describe, expect, it } from 'vitest';
import { checkGoverningFact, normalizeTarget, overlappingEnforced, ruleSizeReport } from '@momonga/memory';
import type { GoverningFactView } from '@momonga/protocol';

const fact = (id: string, overrides: Partial<GoverningFactView> = {}): GoverningFactView => ({
  id,
  kind: 'constraint',
  target: 'pandas',
  text: `text of ${id}`,
  scope: { level: 'project', project: '/work/a', paths: [] },
  validFrom: 1,
  validUntil: null,
  retiredAt: null,
  supersedes: [],
  enforcement: null,
  source: { kind: 'command', at: 1 },
  ...overrides,
});

const parses = (): boolean => true;

describe('normalizeTarget', () => {
  it.each([
    ['pandas', 'pandas'],
    ['PANDAS', 'pandas'],
    ['  pandas  ', 'pandas'],
    ['Production Database', 'production-database'],
    ['  production \t  database\n', 'production-database'],
    ['already-joined', 'already-joined'],
  ])('%j becomes %j', (raw, normalized) => {
    expect(normalizeTarget(raw)).toBe(normalized);
  });
});

describe('checkGoverningFact', () => {
  it('accepts a fact superseding one of its group', () => {
    expect(checkGoverningFact(fact('new', { supersedes: ['old'] }), { existing: [fact('old')], parses })).toEqual({ ok: true });
  });

  it.each<[string, GoverningFactView]>([
    ['another target', fact('old', { target: 'numpy' })],
    ['another project', fact('old', { scope: { level: 'project', project: '/work/b', paths: [] } })],
    ['the user scope', fact('old', { scope: { level: 'user' } })],
    ['other paths', fact('old', { scope: { level: 'project', project: '/work/a', paths: ['src/**'] } })],
  ])('refuses a supersedes entry of %s', (_name, old) => {
    expect(checkGoverningFact(fact('new', { supersedes: ['old'] }), { existing: [old], parses })).toMatchObject({ ok: false, code: 'supersedes_outside_group' });
  });

  it('refuses a supersedes entry that does not exist', () => {
    expect(checkGoverningFact(fact('new', { supersedes: ['absent'] }), { existing: [], parses })).toMatchObject({ ok: false, code: 'supersedes_outside_group' });
  });

  it('refuses an allow enforcement before parsing it', () => {
    const asked: string[] = [];
    const enforcement = { behavior: 'allow', rule: 'Bash(ls:*)' } as unknown as GoverningFactView['enforcement'];
    const result = checkGoverningFact(fact('new', { enforcement }), { existing: [], parses: (rule) => (asked.push(rule), true) });
    expect(result).toMatchObject({ ok: false, code: 'allow_enforcement' });
    expect(asked).toEqual([]);
  });

  it('refuses a rule the policy parser rejects', () => {
    const result = checkGoverningFact(fact('new', { enforcement: { behavior: 'deny', rule: 'Nonsense((' } }), { existing: [], parses: () => false });
    expect(result).toMatchObject({ ok: false, code: 'invalid_rule' });
  });

  it('passes the rule text to the parser and accepts deny and ask', () => {
    const asked: string[] = [];
    const check = (behavior: 'deny' | 'ask') => checkGoverningFact(fact('new', { enforcement: { behavior, rule: 'Bash(rm:*)' } }), { existing: [], parses: (rule) => (asked.push(rule), true) });
    expect(check('deny')).toEqual({ ok: true });
    expect(check('ask')).toEqual({ ok: true });
    expect(asked).toEqual(['Bash(rm:*)', 'Bash(rm:*)']);
  });

  it('refuses an empty target', () => {
    expect(checkGoverningFact(fact('new', { target: '' }), { existing: [], parses })).toMatchObject({ ok: false, code: 'empty_target' });
  });
});

describe('overlappingEnforced', () => {
  const enforced = fact('e', { enforcement: { behavior: 'deny', rule: 'Bash(rm:*)' } });

  it('names a live enforced fact with the target of a text fact', () => {
    expect(overlappingEnforced(fact('t', { enforcement: null }), [enforced, fact('other', { target: 'numpy' })]).map((entry) => entry.id)).toEqual(['e']);
  });

  it('is empty for an enforced new fact, another target and a retired fact', () => {
    expect(overlappingEnforced(enforced, [enforced])).toEqual([]);
    expect(overlappingEnforced(fact('t', { target: 'numpy' }), [enforced])).toEqual([]);
    expect(overlappingEnforced(fact('t'), [{ ...enforced, retiredAt: 5 }])).toEqual([]);
  });
});

describe('ruleSizeReport', () => {
  it('states the tokens of the fact against each target window, by declared capability only', () => {
    expect(ruleSizeReport(100, [{ target: 'small', contextWindow: 1000 }, { target: 'large', contextWindow: 200_000 }])).toEqual([
      { target: 'small', contextWindow: 1000, tokens: 100, percent: 10 },
      { target: 'large', contextWindow: 200_000, tokens: 100, percent: 0.05 },
    ]);
  });
});
