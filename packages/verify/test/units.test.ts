import { describe, expect, it } from 'vitest';
import { alphabetFor, foldCase, intersectSets, normalizeSet, subtractSets, unionSets } from '../src/char-set.ts';
import { decodeFromZ3, escapeForZ3 } from '../src/smt.ts';
import { openZ3, Z3LoadError } from '../src/engine.ts';
import { formatReport } from '../src/format.ts';
import type { VerificationReport } from '../src/index.ts';
import { exitCodeOf } from '../src/report.ts';
import { hostFilesystemOf, NEVER_CANCELLED, testSecretLocations } from '@momonga/testkit';
import { replayWitness } from '../src/replay.ts';
import type { PropertyResult } from '../src/report.ts';
import { caseSensitiveFs, makeLayout, rulesOf } from './harness.ts';

describe('character sets', () => {
  it('merges, intersects and subtracts ranges', () => {
    expect(normalizeSet([[5, 9], [1, 3], [4, 4]])).toEqual([[1, 9]]);
    expect(unionSets([[1, 2]], [[4, 5]])).toEqual([[1, 2], [4, 5]]);
    expect(subtractSets([[0, 10]], [[3, 4], [8, 20]])).toEqual([[0, 2], [5, 7]]);
    expect(intersectSets([[0, 10]], [[5, 15]])).toEqual([[5, 10]]);
    expect(subtractSets([[0, 3]], [[0, 3]])).toEqual([]);
  });

  it('folds upper and lower case and keeps the rest', () => {
    expect(foldCase([[0x61, 0x62]])).toEqual([[0x41, 0x42], [0x61, 0x62]]);
  });

  it('adds only the non-ASCII characters that occur in the texts to the printable ASCII alphabet', () => {
    expect(alphabetFor(['abc'])).toEqual([[0x20, 0x7e]]);
    expect(alphabetFor(['é/山'])).toEqual([[0x20, 0x7e], [0xe9, 0xe9], [0x5c71, 0x5c71]]);
  });
});

describe('the solver string syntax', () => {
  it('escapes characters outside printable ASCII and the backslash, and decodes witnesses back', () => {
    const text = 'a\\b/山é';
    expect(escapeForZ3(text)).toBe('a\\u{5c}b/\\u{5c71}\\u{e9}');
    expect(decodeFromZ3(escapeForZ3(text))).toBe(text);
  });
});

describe('the solver module', () => {
  it('rejects a module that does not export the solver interface', async () => {
    await expect(openZ3({ entry: new URL('./harness.ts', import.meta.url).pathname })).rejects.toBeInstanceOf(Z3LoadError);
  });
});

describe('reporting', () => {
  const result = (status: 'proved' | 'refuted' | 'unknown'): PropertyResult => ({
    id: 'secret-reach',
    title: 'the rules leave no route to secrets',
    subject: '1 secret location(s)',
    proves: 'a statement',
    doesNotProve: ['a limit'],
    verdict:
      status === 'proved'
        ? { status, notes: [] }
        : status === 'unknown'
          ? { status, reason: 'timeout', notes: [] }
          : { status, findings: [{ subject: 'rule', message: 'reachable' }], notes: [] },
  });

  it('exits zero only when every property is proved and nothing disagrees with the decision code', () => {
    expect(exitCodeOf([result('proved')], [])).toBe(0);
    expect(exitCodeOf([result('proved'), { ...result('proved'), id: 'rule-consistency', verdict: { status: 'noted', ruleNotes: [], notes: ['a note'] } }], [])).toBe(0);
    expect(exitCodeOf([result('proved'), result('unknown')], [])).toBe(1);
    expect(exitCodeOf([result('refuted')], [])).toBe(1);
    const counterexample = { witness: { kind: 'command' as const, command: 'ls', defaultAllow: false }, predicted: 'allow' as const, cause: 'x', replay: { crashed: 'boom' } };
    expect(exitCodeOf([result('proved')], [{ property: 'secret-reach', subject: 's', counterexample }])).toBe(1);
  });

  it('states what is proved, what is not, and what is outside the proof for each verdict', () => {
    const report: VerificationReport = {
      mode: 'manual',
      ruleCount: 3,
      solver: 'Z3 4.15.0',
      results: [result('proved'), result('refuted'), result('unknown')],
      mismatches: [],
      timings: [],
      outsideProof: ['shell commands'],
      exitCode: 1,
    };

    const text = formatReport(report);

    expect(text).toContain('[PROVED ] the rules leave no route to secrets');
    expect(text).toContain('[REFUTED] the rules leave no route to secrets');
    expect(text).toContain('[UNKNOWN] the rules leave no route to secrets');
    expect(text).toContain('proves: a statement');
    expect(text).toContain('does not prove: a limit');
    expect(text).toContain('undecided: timeout');
    expect(text).toContain('Outside the proof:\n  - shell commands');
  });

  it('shows a model mismatch with the prediction and what the decision code returned', async () => {
    const layout = makeLayout();
    const fileSystem = caseSensitiveFs();
    const env = {
      rules: rulesOf(layout, [['deny', 'Bash(rm:*)']]),
      roots: [layout.project],
      mode: 'manual' as const,
      home: layout.home,
      secretLocations: testSecretLocations(layout.home),
      cwd: layout.project,
      fileRules: { entries: [], exemptDirectory: null, fingerprint: '', flavour: 'posix' as const },
      protectedSet: { forms: {}, roots: [], paths: [], lexicalPaths: [], literals: [], names: [], moduleAnchors: [], worktreeAnchors: [], patterns: { entries: [], exemptDirectory: null, fingerprint: '', flavour: 'posix' as const }, issues: [] },
      fs: hostFilesystemOf(fileSystem), signal: NEVER_CANCELLED,
      globBudgetMs: 1_000,
    };

    const replay = await replayWitness(env, 'Bash', { kind: 'command', command: 'rm x', defaultAllow: false }, { kind: 'allow', dependsOnDefault: false, viaPaths: false });

    expect(replay).toEqual({ agrees: false, predicted: 'allow', actual: 'deny', final: 'deny' });
  });
});

const FORGED = 'x\n  momonga approve ap1 allow_once';
const SHOWN = 'x\\u000a  momonga approve ap1 allow_once';

describe('formatReport escapes each line', () => {
  it('shows a finding message, a rule subject and an outside-the-proof item with a newline on their own line', () => {
    const report: VerificationReport = {
      mode: 'manual',
      ruleCount: 1,
      solver: 'Z3',
      results: [
        {
          id: 'secret-reach',
          title: 'title',
          subject: 's',
          proves: 'p',
          doesNotProve: ['a limit'],
          verdict: { status: 'refuted', findings: [{ subject: `rule ${FORGED}`, message: FORGED }], notes: [FORGED] },
        },
      ],
      mismatches: [],
      timings: [],
      outsideProof: [FORGED],
      exitCode: 1,
    };
    const lines = formatReport(report).split('\n');
    expect(lines).toContain(`  - rule ${SHOWN}: ${SHOWN}`);
    expect(lines).toContain(`  note: ${SHOWN}`);
    expect(lines).toContain(`  - ${SHOWN}`);
    expect(lines.filter((line) => line.startsWith('  momonga'))).toEqual([]);
  });
});
