import { describe, expect, it } from 'vitest';
import { unixSocketPolicyOf } from '@momonga/foundation';
import type { UnixSocketPolicy } from '@momonga/foundation';
import { formatReport } from '../src/format.ts';
import type { PropertyResult, VerificationReport } from '../src/report.ts';

const proved: PropertyResult = { id: 'secret-reach', title: 'the rules leave no route to secrets', subject: 'Read', proves: 'p', doesNotProve: ['a limit'], verdict: { status: 'proved', notes: [] } };

const refuted: PropertyResult = { ...proved, verdict: { status: 'refuted', findings: [{ subject: 'Read', message: 'an allow rule opens a secret location' }], notes: [] } };

const unknown: PropertyResult = { ...proved, id: 'mandate-holds', verdict: { status: 'unknown', reason: 'the time for the proof ran out', notes: [] } };

const reportOf = (results: readonly PropertyResult[], unixSockets: UnixSocketPolicy = unixSocketPolicyOf('seatbelt', [])): VerificationReport => ({
  mode: 'manual',
  ruleCount: 1,
  solver: 'Z3 4.15.0',
  results,
  mismatches: [],
  timings: [],
  outsideProof: ['shell commands'],
  unixSockets,
  exitCode: results.every((result) => result.verdict.status === 'proved') ? 0 : 1,
});

const lastLine = (report: VerificationReport): string => formatReport(report).split('\n').at(-1) ?? '';

describe('the closing line of the verification report', () => {
  it('says no rule is refuted when every property holds', () => {
    expect(lastLine(reportOf([proved]))).toBe('No rule is refuted');
  });

  it('names the refuted property in words', () => {
    expect(lastLine(reportOf([proved, refuted, unknown]))).toBe('Refuted: the property that no allow rule you wrote opens a secret location');
  });

  it('gives the reason of an undecided property and says it is tried again', () => {
    expect(lastLine(reportOf([proved, unknown]))).toBe('Unknown: the property that a run under a mandate stays inside it (the time for the proof ran out); it is tried again in the background');
  });
});

describe('the Unix socket line of the verification report', () => {
  const socketLines = (unixSockets: UnixSocketPolicy): string[] => formatReport(reportOf([proved], unixSockets)).split('\n').filter((line) => line.startsWith('Unix sockets:'));

  it.each(['seatbelt', 'bubblewrap'] as const)('on %s lists the named sockets, or says they are all denied', (kind) => {
    expect(socketLines(unixSocketPolicyOf(kind, []))).toEqual(['Unix sockets: denied']);
    expect(socketLines(unixSocketPolicyOf(kind, ['/run/docker.sock', '/tmp/agent.sock']))).toEqual(['Unix sockets: denied except /run/docker.sock, /tmp/agent.sock']);
  });

  it('says they are not limited with sandbox none', () => {
    expect(socketLines(unixSocketPolicyOf('none', ['/run/docker.sock']))).toEqual(['Unix sockets: not limited (sandbox: none)']);
  });
});
