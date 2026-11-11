import { describe, expect, it } from 'vitest';
import { formatReport } from '../src/index.ts';
import type { PropertyResult, VerificationReport } from '../src/report.ts';

const result = (title: string, verdict: PropertyResult['verdict']): PropertyResult => ({ id: 'secret-reach' as PropertyResult['id'], title, subject: 'the rules', proves: 'p', doesNotProve: [], verdict });

const report = (results: PropertyResult[]): VerificationReport => ({ mode: 'manual', ruleCount: 1, solver: 'z3', results, mismatches: [], timings: [], outsideProof: ['x'], exitCode: 0 });

const lastLine = (text: string): string => text.split('\n').at(-1) ?? '';

describe('the policy verify report ends with one result line (cli-commands-C42)', () => {
  it('no refuted and no undecided property: No rule is refuted', () => {
    expect(lastLine(formatReport(report([result('Secrets', { status: 'proved', notes: [] })])))).toBe('No rule is refuted');
  });

  it('a refuted property names it', () => {
    expect(lastLine(formatReport(report([result('Secrets', { status: 'refuted', findings: [], notes: [] }), result('Forms', { status: 'unknown', reason: 'timeout', notes: [] })])))).toBe('Refuted: Secrets');
  });

  it('an undecided property and no refuted one names the reason', () => {
    expect(lastLine(formatReport(report([result('Forms', { status: 'unknown', reason: 'the solver timed out', notes: [] })])))).toBe('Unknown: Forms: the solver timed out');
  });
});
