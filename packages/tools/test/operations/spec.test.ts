import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPERATION_SPECS, OperationSpecError, describeClause, evaluateClauses, failedClauses, parseOperationSpec, supersededForms } from '@momonga/tools';
import type { Clause, ClauseItem } from '@momonga/tools';
import { expectRejected } from './support.ts';

const SPEC_DIR = path.resolve(import.meta.dirname, '../../src/operations/specs');

const CATALOGUE = ['GitBranch', 'GitStage', 'GitFetch', 'GitUpdate', 'GitCommit', 'GitPush', 'PullRequestStatus', 'PullRequestComments', 'PullRequestCreate', 'PullRequestMerge', 'PullRequestComment'];

const rawSpecs = (): Array<Record<string, unknown>> =>
  fs
    .readdirSync(SPEC_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(fs.readFileSync(path.join(SPEC_DIR, file), 'utf8')) as Record<string, unknown>);

const rawOf = (name: string): Record<string, unknown> => {
  const raw = rawSpecs().find((spec) => spec['name'] === name);
  if (raw === undefined) throw new Error(`no spec file for ${name}`);
  return raw;
};

const specOf = (name: string) => {
  const spec = OPERATION_SPECS.find((candidate) => candidate.name === name);
  if (spec === undefined) throw new Error(`no built-in spec ${name}`);
  return spec;
};

describe('the operation catalogue', () => {
  it('is built from one data file per operation and holds exactly the Phase 1 operations', () => {
    expect(rawSpecs().map((spec) => spec['name']).sort()).toEqual([...CATALOGUE].sort());
    expect(OPERATION_SPECS.map((spec) => spec.name).sort()).toEqual([...CATALOGUE].sort());
  });

  it('parses every shipped file to the spec the catalogue holds', () => {
    for (const raw of rawSpecs()) expect(parseOperationSpec(raw)).toEqual(specOf(String(raw['name'])));
  });

  it.each([
    ['PullRequestCreate', 'server_unique'],
    ['GitPush', 'compare_and_set'],
    ['PullRequestMerge', 'compare_and_set'],
    ['PullRequestComment', 'none'],
  ] as const)('gives %s the guard %s', (name, guard) => {
    expect(specOf(name).guard).toBe(guard);
  });

  it.each([
    ['GitBranch', 'rule'],
    ['GitCommit', 'rule'],
    ['GitPush', 'rule'],
    ['PullRequestCreate', 'rule'],
    ['PullRequestComment', 'rule'],
    ['PullRequestMerge', 'always'],
  ] as const)('gives %s the approval class %s', (name, approval) => {
    expect(specOf(name).approval).toBe(approval);
  });

  it('marks the two operations that read a pull request as the only read-only operations, with no effect', () => {
    expect(OPERATION_SPECS.filter((spec) => spec.sideEffect === 'read_only').map((spec) => spec.name).sort()).toEqual(['PullRequestComments', 'PullRequestStatus']);
    expect(specOf('PullRequestStatus').effect).toBeUndefined();
    expect(specOf('PullRequestComments').effect).toBeUndefined();
  });

  it('reads the checks of PullRequestStatus for the head commit the forge gave for the pull request in the same observation', () => {
    const probes = specOf('PullRequestStatus').observe;
    expect(probes.map((probe) => probe.via).map((via) => ('forge' in via ? via.forge : 'argv'))).toEqual(['getPullRequest', 'listChecks']);
    expect(probes[1]?.via).toMatchObject({ args: { headSha: '{seen.pr.headSha}' }, shape: 'lines' });
  });

  it('gives every operation that changes state exactly one effect and at least one probe', () => {
    for (const spec of OPERATION_SPECS.filter((candidate) => candidate.sideEffect !== 'read_only')) {
      expect(Array.isArray(spec.effect)).toBe(false);
      expect(spec.effect).toBeDefined();
      expect(spec.observe.length).toBeGreaterThan(0);
      expect(spec.applied.length).toBeGreaterThan(0);
    }
  });

  it.each([
    ['GitPush', ['git', 'push']],
    ['GitCommit', ['git', 'commit']],
    ['PullRequestCreate', ['gh', 'pr', 'create']],
    ['PullRequestMerge', ['gh', 'pr', 'merge']],
    ['PullRequestComment', ['gh', 'pr', 'comment']],
  ] as const)('lists the Bash form that %s replaces', (name, argv) => {
    expect(specOf(name).supersedes).toContainEqual(argv);
    expect(supersededForms(OPERATION_SPECS)).toContainEqual({ operation: name, argv });
  });
});

describe('loading an operation spec', () => {
  it('rejects a spec with two effects (G1 OneEffect)', () => {
    const raw = rawOf('GitCommit');
    expectRejected(() => parseOperationSpec({ ...raw, effect: [raw['effect'], raw['effect']] }), OperationSpecError);
  });

  it('rejects a spec that declares a second effect under another key (G1 OneEffect)', () => {
    const raw = rawOf('PullRequestCreate');
    expectRejected(() => parseOperationSpec({ ...raw, effects: [raw['effect']] }), OperationSpecError);
  });

  it('rejects a state-changing spec without an applied clause, which would make every call look applied', () => {
    expectRejected(() => parseOperationSpec({ ...rawOf('GitPush'), applied: [] }), OperationSpecError);
  });

  it('rejects a spec whose guard is not one of the three guards', () => {
    expectRejected(() => parseOperationSpec({ ...rawOf('PullRequestCreate'), guard: 'retry' }), OperationSpecError);
  });

  it('rejects an approval class other than rule or always', () => {
    expectRejected(() => parseOperationSpec({ ...rawOf('PullRequestMerge'), approval: 'never' }), OperationSpecError);
  });

  const messageOf = (attempt: () => unknown): string => {
    try {
      attempt();
    } catch (error) {
      return (error as Error).message;
    }
    return '';
  };

  const statusWith = (checks: Record<string, unknown>): Record<string, unknown> => {
    const raw = rawOf('PullRequestStatus');
    const [pr] = raw['observe'] as Array<Record<string, unknown>>;
    return { ...raw, observe: [pr, { id: 'checks', via: { forge: 'listChecks', args: { headSha: '{seen.pr.headSha}' }, ...checks } }] };
  };

  it('rejects a probe that lists every item as lines without the forms of a line', () => {
    expect(messageOf(() => parseOperationSpec(statusWith({ shape: 'lines' })))).toBe('PullRequestStatus: the probe checks lists every item and must give the forms of a line in lines');
  });

  it('rejects the forms of a line on a probe that does not list every item', () => {
    expect(messageOf(() => parseOperationSpec(statusWith({ shape: 'list', lines: ['{item.name}'] })))).toBe('PullRequestStatus: the probe checks gives the forms of a line but does not list every item (shape lines)');
  });

  it('rejects a probe that reads a value of this observation from a probe that does not come before it', () => {
    const raw = rawOf('PullRequestStatus');
    const [pr, checks] = raw['observe'] as Array<Record<string, unknown>>;
    expect(messageOf(() => parseOperationSpec({ ...raw, observe: [checks, pr] }))).toBe('PullRequestStatus: the probe checks reads seen.pr.headSha, but no probe named pr comes before it');
  });
});

describe('the clause evaluator', () => {
  const scope = {
    before: { head: 'h1', indexTree: 't1' },
    after: { headParent: 'h1', headTree: 't1', headMessage: 'Add x', pr: { merged: 'true' } },
    input: { message: 'Add x' },
  };

  const commitApplied: Clause[] = [
    ['after.headParent', 'before.head'],
    ['after.headTree', 'before.indexTree'],
    ['after.headMessage', 'input.message'],
  ];

  it('holds when every equality holds', () => {
    expect(evaluateClauses(commitApplied, scope)).toBe(true);
  });

  it('fails when one equality fails', () => {
    expect(evaluateClauses(commitApplied, { ...scope, after: { ...scope.after, headTree: 't2' } })).toBe(false);
  });

  it('compares with a literal string', () => {
    expect(evaluateClauses([['after.pr.merged', { literal: 'true' }]], scope)).toBe(true);
    expect(evaluateClauses([['after.pr.merged', { literal: 'false' }]], scope)).toBe(false);
  });

  it('is false, never an error, when a reference names a value that was not observed', () => {
    expect(evaluateClauses([['after.missing', 'before.head']], scope)).toBe(false);
    expect(evaluateClauses([['after.pr.merged.deeper', { literal: 'true' }]], scope)).toBe(false);
  });

  it('does not treat two missing values as equal', () => {
    expect(evaluateClauses([['after.missing', 'before.missing']], scope)).toBe(false);
  });

  it('does not treat two empty observations as equal', () => {
    const empty = { before: { localSha: '', remoteRef: '' }, after: { remoteRef: '' } };
    expect(evaluateClauses([['after.remoteRef', 'before.localSha']], empty)).toBe(false);
    expect(evaluateClauses([['after.remoteRef', 'before.remoteRef']], empty)).toBe(false);
  });

  it('lets an empty observation equal only the empty literal a spec writes for an intended absence', () => {
    const empty = { after: { remoteRef: '' } };
    expect(evaluateClauses([['after.remoteRef', { literal: '' }]], empty)).toBe(true);
    expect(evaluateClauses([['after.remoteRef', { literal: '' }]], { after: { remoteRef: 'abc' } })).toBe(false);
    expect(evaluateClauses([['after.missing', { literal: '' }]], empty)).toBe(false);
  });

  it('holds an observed clause only for a value that was observed and is not empty, and describes it by its own text', () => {
    const clause: Clause = { observed: 'before.localSha', otherwise: 'the local branch {input.branch} does not exist' };
    const input = { branch: 'topic' };
    expect(evaluateClauses([clause], { input, before: { localSha: 'abc' } })).toBe(true);
    expect(evaluateClauses([clause], { input, before: { localSha: '' } })).toBe(false);
    expect(evaluateClauses([clause], { input, before: {} })).toBe(false);
    expect(failedClauses([clause], { input, before: {} }).map((failed) => describeClause(failed, { input, before: {} }))).toEqual(['the local branch topic does not exist']);
  });

  it('chooses the clauses of an ifObserved item by whether the value was observed', () => {
    const unchanged: ClauseItem[] = [{ ifObserved: 'before.remoteRef', then: [['after.remoteRef', 'before.remoteRef']], else: [['after.remoteRef', { literal: '' }]] }];
    expect(evaluateClauses(unchanged, { before: { remoteRef: 'abc' }, after: { remoteRef: 'abc' } })).toBe(true);
    expect(evaluateClauses(unchanged, { before: { remoteRef: 'abc' }, after: { remoteRef: '' } })).toBe(false);
    expect(evaluateClauses(unchanged, { before: { remoteRef: '' }, after: { remoteRef: '' } })).toBe(true);
    expect(evaluateClauses(unchanged, { before: { remoteRef: '' }, after: { remoteRef: 'abc' } })).toBe(false);
  });

  it('gives the same answer for the same inputs, whatever the clause order', () => {
    const reversed = [...commitApplied].reverse();
    expect(evaluateClauses(reversed, scope)).toBe(evaluateClauses(commitApplied, scope));
  });
});

describe('what an approval names is what the effect does (every field of the permission subject)', () => {
  const referencesIn = (text: string): string[] => [...text.matchAll(/\{(input\.[A-Za-z0-9_]+)\}/g)].map((match) => match[1] as string);

  const subjectReferences = (subject: Record<string, unknown>): string[] => [
    ...Object.entries(subject).flatMap(([key, value]) => (key === 'kind' || key === 'alwaysWhen' ? [] : (Array.isArray(value) ? value : [value]).flatMap((entry) => referencesIn(String(entry))))),
    ...(Array.isArray(subject['alwaysWhen']) ? subject['alwaysWhen'].map((flag) => `input.${String(flag)}`) : []),
  ];

  const boundReferences = (spec: Record<string, unknown>): Set<string> => {
    const text = JSON.stringify([spec['effect'] ?? null, spec['require'] ?? []]);
    return new Set([...referencesIn(text), ...[...text.matchAll(/"(input\.[A-Za-z0-9_]+)"/g)].map((match) => match[1] as string)]);
  };

  it.each(CATALOGUE)('%s: each subject field is an argument of the effect or is required against an observation', (name) => {
    const spec = rawOf(name);
    if (spec['effect'] === undefined) return;
    const bound = boundReferences(spec);
    expect(subjectReferences(spec['subject'] as Record<string, unknown>).filter((reference) => !bound.has(reference))).toEqual([]);
  });

  it('refuses at load a spec whose subject carries a field the effect does not take and no require clause checks', () => {
    const { require: _checked, ...unchecked } = rawOf('PullRequestCreate');
    let message = '';
    try {
      parseOperationSpec(unchecked);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('PullRequestCreate: the approval names input.headSha, which is neither an argument of the effect nor required against an observation');
  });

  it('requires the head branch of PullRequestCreate to be at the approved commit, observed from the forge', () => {
    const spec = OPERATION_SPECS.find((candidate) => candidate.name === 'PullRequestCreate');
    expect(spec?.require).toEqual([['before.headBranch.sha', 'input.headSha']]);
    expect(spec?.observe.find((probe) => probe.id === 'headBranch')?.via).toMatchObject({ forge: 'getBranch', args: { branch: '{input.head}' } });
  });
});
