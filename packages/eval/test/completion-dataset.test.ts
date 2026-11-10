import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as evaluation from '@momonga/eval';
import { DATASET_FORMAT, gradeChecks, mandateOfTask, parseDataset } from '@momonga/eval';

const DATASET_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'datasets', 'completion.json');

const baseCase = {
  id: 'fix-failing-check',
  input: 'Make the check pass.',
  permissionMode: 'acceptEdits',
  onAsk: 'reject_once',
  runs: 1,
  minPassRate: 1,
  files: { 'check.sh': 'exit 1\n' },
};

const dataset = (extra: Record<string, unknown>) => JSON.stringify({ format: DATASET_FORMAT, name: 'completion', cases: [{ ...baseCase, ...extra }] });

type Agreement = { gatePassOraclePass: number; gatePassOracleFail: number; gateFailOraclePass: number; gateFailOracleFail: number; gateNotRun: number };

const completionAgreement = (rows: readonly { gate: string; oracle: boolean }[]): Agreement => {
  const found = (evaluation as Record<string, unknown>)['completionAgreement'];
  if (typeof found !== 'function') throw new Error('@momonga/eval does not export completionAgreement');
  return (found as (value: typeof rows) => Agreement)(rows);
};

describe('completion cases in a golden dataset', () => {
  it('accepts a completion declaration given to the run, an oracle the harness runs after it, and the verification and oracle graders', () => {
    const parsed = parseDataset(
      dataset({
        completion: { conditions: [{ command: 'sh check.sh' }] },
        oracle: ORACLE,
        graders: [{ kind: 'verification', equals: 'passed' }, { kind: 'oracle' }, { kind: 'stopReason', equals: 'conditions_unmet' }],
      }),
      'inline',
    );
    expect(parsed.cases[0]).toMatchObject({ completion: { conditions: [{ command: 'sh check.sh' }] }, oracle: ORACLE });
  });

  it('rejects an oracle given as a single object instead of a list of checks', () => {
    expect(() => parseDataset(dataset({ oracle: { command: 'sh check.sh' }, graders: [{ kind: 'oracle' }] }), 'inline')).toThrow();
  });

  it('rejects an oracle check of an unknown kind', () => {
    expect(() => parseDataset(dataset({ oracle: [{ id: 'x', kind: 'judge', prompt: 'is it done?' }], graders: [{ kind: 'oracle' }] }), 'inline')).toThrow();
  });
});

const probeOf = (exits: Record<string, number | 'timeout'>, digests: { workspace: string; base: string }, changed: string[], ran: string[] = []) => ({
  run: async (command: string) => {
    ran.push(command);
    const exit = exits[command];
    return exit === 'timeout' ? { exitCode: null, timedOut: true } : { exitCode: exit ?? 127, timedOut: false };
  },
  digest: async (cwd: string) => (cwd === 'work' ? digests.workspace : digests.base),
  changedPaths: async () => changed,
});

const gradeWith = (checks: readonly object[], probe: ReturnType<typeof probeOf>) =>
  gradeChecks({ checks: checks as never, graderFiles: {}, workspace: 'work', base: 'base', probe });

const within = async (allowed: string[], changed: string[]): Promise<boolean> =>
  (await gradeWith([{ id: 'bounded', kind: 'changedPathsWithin', paths: allowed }], probeOf({}, { workspace: '', base: '' }, changed))).met;

describe('grading the oracle checks after the run', () => {
  const tests = { id: 'tests', kind: 'command', run: 'sh check.sh', expectExit: 0, evidence: 'acceptance', timeoutMs: 60_000 };
  const kept = { id: 'kept', kind: 'unchangedPaths', paths: ['nowhere/check.sh'] };
  const bounded = { id: 'bounded', kind: 'changedPathsWithin', paths: ['src/'] };

  it('meets the oracle only when every check passes', async () => {
    const ran: string[] = [];
    const verdict = await gradeWith([tests, kept, bounded], probeOf({ 'sh check.sh': 0 }, { workspace: 'd1', base: 'd1' }, ['src/a.ts'], ran));
    expect(verdict).toEqual({ met: true, checks: [{ id: 'tests', passed: true }, { id: 'kept', passed: true }, { id: 'bounded', passed: true }] });
    expect(ran).toEqual(['sh check.sh']);
  });

  it('fails a command check on an exit code other than the expected one, and a timeout with reason timeout', async () => {
    expect(await gradeWith([tests], probeOf({ 'sh check.sh': 1 }, { workspace: '', base: '' }, []))).toMatchObject({ met: false, checks: [{ id: 'tests', passed: false }] });
    expect(await gradeWith([tests], probeOf({ 'sh check.sh': 'timeout' }, { workspace: '', base: '' }, []))).toMatchObject({ met: false, checks: [{ id: 'tests', passed: false, reason: 'timeout' }] });
  });

  it('fails unchangedPaths when the model edited a protected path, even if the tests pass', async () => {
    const verdict = await gradeWith([tests, kept], probeOf({ 'sh check.sh': 0 }, { workspace: 'd2', base: 'd1' }, []));
    expect(verdict).toMatchObject({ met: false, checks: [{ id: 'tests', passed: true }, { id: 'kept', passed: false }] });
  });

  it('fails changedPathsWithin when the diff leaves the allowed paths', async () => {
    expect(await gradeWith([bounded], probeOf({}, { workspace: '', base: '' }, ['src/a.ts', 'package.json']))).toMatchObject({ met: false, checks: [{ id: 'bounded', passed: false }] });
  });

  it('matches whole path segments and refuses a path that escapes through a parent segment', async () => {
    expect(await within(['src'], ['src', 'src/a.ts', 'src/deep/b.ts'])).toBe(true);
    expect(await within(['src/'], ['src/a.ts'])).toBe(true);
    expect(await within(['./src'], ['src/a.ts'])).toBe(true);
    expect(await within(['src'], ['src2/a.ts'])).toBe(false);
    expect(await within(['src/'], ['src2/a.ts'])).toBe(false);
    expect(await within(['src'], ['src/../secrets.txt'])).toBe(false);
    expect(await within(['src'], ['../src/a.ts'])).toBe(false);
  });
});

describe('the declaration of a benchmark task', () => {
  it('becomes the completion of the mandate sent with the run, and is absent when the task declares nothing', () => {
    expect(mandateOfTask({ declaration: [] })).toBeUndefined();
    expect(mandateOfTask({ declaration: [{ id: 'tests', command: 'node --test', when: 'always' }] })).toEqual({
      completion: { conditions: [{ id: 'tests', command: 'node --test', when: 'always' }] },
    });
  });
});

const ORACLE = [
  { id: 'tests', kind: 'command', run: 'sh check.sh', expectExit: 0, evidence: 'acceptance', timeoutMs: 60_000 },
  { id: 'kept', kind: 'unchangedPaths', paths: ['check.sh'] },
  { id: 'bounded', kind: 'changedPathsWithin', paths: ['src/'] },
];

describe('the gate against the independent oracle', () => {
  it('counts the 2x2 table, where gate passed with oracle failed is the defect, and keeps runs with no gate verdict apart', () => {
    expect(
      completionAgreement([
        { gate: 'passed', oracle: true },
        { gate: 'passed', oracle: true },
        { gate: 'passed', oracle: false },
        { gate: 'failed', oracle: true },
        { gate: 'failed', oracle: false },
        { gate: 'not_run', oracle: true },
      ]),
    ).toEqual({ gatePassOraclePass: 2, gatePassOracleFail: 1, gateFailOraclePass: 1, gateFailOracleFail: 1, gateNotRun: 1 });
  });
});

describe('the completion dataset', () => {
  it('exists and parses, and every case gives a failing workspace, a declaration and an oracle', () => {
    const parsed = parseDataset(fs.readFileSync(DATASET_FILE, 'utf8'), DATASET_FILE) as unknown as { cases: { files?: object; completion?: { conditions?: unknown[] }; oracle?: { kind?: string }[] }[] };
    expect(parsed.cases.length).toBeGreaterThan(0);
    for (const golden of parsed.cases) {
      expect(Object.keys(golden.files ?? {}).length).toBeGreaterThan(0);
      expect(golden.completion?.conditions?.length ?? 0).toBeGreaterThan(0);
      expect((golden.oracle ?? []).some((check) => check.kind === 'command')).toBe(true);
    }
  });
});
