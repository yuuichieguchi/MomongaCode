import { describe, expect, it } from 'vitest';
import { unixSocketPolicyOf } from '@momonga/foundation';
import { formatReport } from '../src/index.ts';
import type { PropertyResult, VerificationReport } from '../src/report.ts';

const proved: PropertyResult = { id: 'secret-reach', title: 'Secrets', subject: 'the rules', proves: 'p', doesNotProve: [], verdict: { status: 'proved', notes: [] } };

const refuted: PropertyResult = { ...proved, verdict: { status: 'refuted', findings: [], notes: [] } };

const unknown: PropertyResult = { ...proved, id: 'mandate-holds', verdict: { status: 'unknown', reason: 'the solver timed out', notes: [] } };

const report = (results: PropertyResult[]): VerificationReport => ({ mode: 'manual', ruleCount: 1, solver: 'z3', results, mismatches: [], timings: [], outsideProof: ['x'], unixSockets: unixSocketPolicyOf('seatbelt', []), exitCode: 0 });

const RESULT_LINE = /^(No rule is refuted|Refuted: |Unknown: )/;

const resultLines = (text: string): string[] => text.split('\n').filter((line) => RESULT_LINE.test(line));

describe('the policy verify report ends with one result line, the one of the report format (cli-commands-C42, policy-verify-sandbox C23)', () => {
  it.each([
    ['every property proved', [proved], /^No rule is refuted$/],
    ['a refuted property among others', [refuted, unknown], /^Refuted: /],
    ['an undecided property and no refuted one', [proved, unknown], /^Unknown: .*\(the solver timed out\)/],
  ] as const)('%s: exactly one result line, and it is the last line', (_case, results, expected) => {
    const text = formatReport(report([...results]));
    expect(resultLines(text)).toHaveLength(1);
    expect(text.split('\n').at(-1)).toMatch(expected);
  });
});
