import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPERATION_SPECS, OperationSpecError, evaluateClauses, parseOperationSpec, supersededForms } from '@momonga/tools';
import type { Clause } from '@momonga/tools';
import { expectRejected } from './support.ts';

const SPEC_DIR = path.resolve(import.meta.dirname, '../../src/operations/specs');

const CATALOGUE = ['GitBranch', 'GitCommit', 'GitPush', 'PullRequestStatus', 'PullRequestCreate', 'PullRequestMerge', 'PullRequestComment'];

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

  it('marks PullRequestStatus as the only read-only operation, with no effect', () => {
    expect(OPERATION_SPECS.filter((spec) => spec.sideEffect === 'read_only').map((spec) => spec.name)).toEqual(['PullRequestStatus']);
    expect(specOf('PullRequestStatus').effect).toBeUndefined();
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

  it('gives the same answer for the same inputs, whatever the clause order', () => {
    const reversed = [...commitApplied].reverse();
    expect(evaluateClauses(reversed, scope)).toBe(evaluateClauses(commitApplied, scope));
  });
});
