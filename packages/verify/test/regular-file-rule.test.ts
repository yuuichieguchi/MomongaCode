import fs from 'node:fs';
import path from 'node:path';
import type { RuleNote } from '@momonga/protocol';
import { describe, expect, it } from 'vitest';
import { verdictOfReport } from '../src/index.ts';
import type { VerificationReport } from '../src/index.ts';
import {
  SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS,
  SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  caseInsensitiveFs,
  caseSensitiveFs,
  makeLayout,
  rulesOf,
  useZ3,
  verifyScenario,
} from './harness.ts';

const z3 = useZ3();

const notesOf = (report: VerificationReport): readonly RuleNote[] => {
  const verdict = report.results.find((result) => result.id === 'rule-consistency')?.verdict;
  return verdict?.status === 'noted' ? verdict.ruleNotes : [];
};

describe('rules naming an existing regular file', () => {
  it.each([
    ['case-sensitive', caseSensitiveFs],
    ['case-insensitive', caseInsensitiveFs],
  ] as const)('verifies Read(//.../README.md) inside the workspace without model mismatch (%s)', async (_label, makeFs) => {
    const layout = makeLayout();
    const readme = path.join(layout.project, 'README.md');
    fs.writeFileSync(readme, '# hello\n');

    const report = await verifyScenario(z3.engine().api, layout, rulesOf(layout, [['allow', `Read(/${readme})`]]), { fileSystem: makeFs() });

    expect(report.mismatches).toEqual([]);
    expect(verdictOfReport(report, 'z3 1').verdict).toBe('proved');
    expect(notesOf(report)).toEqual([expect.objectContaining({ kind: 'implied-by-mode', rules: [expect.objectContaining({ text: `Read(/${readme})` })] })]);
  }, SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS);

  it('verifies Read(//.../note.md) outside the workspace without model mismatch', async () => {
    const layout = makeLayout();
    const note = path.join(layout.outside, 'note.md');
    fs.writeFileSync(note, 'outside\n');

    const report = await verifyScenario(z3.engine().api, layout, rulesOf(layout, [['allow', `Read(/${note})`]]));

    expect(report.mismatches).toEqual([]);
    expect(verdictOfReport(report, 'z3 1').verdict).toBe('proved');
    expect(notesOf(report)).toEqual([]);
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('verifies Read on a symlink to an existing regular file without model mismatch', async () => {
    const layout = makeLayout();
    const target = path.join(layout.outside, 'target.md');
    const link = path.join(layout.outside, 'link.md');
    fs.writeFileSync(target, 'target\n');
    fs.symlinkSync(target, link);

    const report = await verifyScenario(z3.engine().api, layout, rulesOf(layout, [['allow', `Read(/${link})`]]));

    expect(report.mismatches).toEqual([]);
    expect(verdictOfReport(report, 'z3 1').verdict).toBe('proved');
    expect(notesOf(report)).toEqual([]);
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('notes a rule below an existing regular file as never-matches without model mismatch', async () => {
    const layout = makeLayout();
    const readme = path.join(layout.project, 'README.md');
    fs.writeFileSync(readme, '# hello\n');
    const impossible = path.join(readme, 'child');

    const report = await verifyScenario(z3.engine().api, layout, rulesOf(layout, [['allow', `Read(/${impossible})`]]));

    expect(report.mismatches).toEqual([]);
    expect(verdictOfReport(report, 'z3 1').verdict).toBe('proved');
    expect(notesOf(report)).toEqual([expect.objectContaining({ kind: 'never-matches' })]);
  }, SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS);

  it('verifies Edit and deny rules naming an existing regular file without model mismatch', async () => {
    const layout = makeLayout();
    const readme = path.join(layout.project, 'README.md');
    fs.writeFileSync(readme, '# hello\n');

    const report = await verifyScenario(z3.engine().api, layout, rulesOf(layout, [['allow', `Edit(/${readme})`], ['deny', `Read(/${readme})`]]));

    expect(report.mismatches).toEqual([]);
    expect(verdictOfReport(report, 'z3 1').verdict).toBe('proved');
  }, SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS);
});
