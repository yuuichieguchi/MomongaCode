import { describe, expect, it } from 'vitest';
import { EXIT_RETIRED, markerReapClockBoundMs } from '@momonga/foundation';
import { DAEMON_MARKER_KILL_GRACE_MS, STARTUP_TIMEOUT_MS, STDIO_FLUSH_MS } from '../src/constants.ts';
import { childRestartBoundMs, classifyExit, decideAfterExit, DEFAULT_RESTART_POLICY, backoffDelay, failureWithoutProcess, resolveRestartPolicy, stopReasonRank } from '../src/restart-policy.ts';
import type { ExitClassification, StopReason } from '../src/restart-policy.ts';

type ExitInput = { code: number | null; signal: NodeJS.Signals | null };

const ANY_EXITS: ExitInput[] = [
  { code: 0, signal: null },
  { code: 1, signal: null },
  { code: 134, signal: null },
  { code: 75, signal: null },
  { code: 78, signal: null },
  { code: null, signal: 'SIGKILL' },
  { code: null, signal: 'SIGTERM' },
  { code: null, signal: 'SIGSEGV' },
];

const policy = DEFAULT_RESTART_POLICY;
const decide = (exit: ExitClassification, consecutiveFailures = 0, random: () => number = () => 0.5) =>
  decideAfterExit({ exit, consecutiveFailures, policy, random });

describe('classifyExit', () => {
  it('classifyExit table', () => {
    const stopRows: [StopReason, ExitClassification][] = [
      ['shutdown', { class: 'requested', reason: 'requested' }],
      ['startup-timeout', { class: 'failure', reason: 'startup-timeout' }],
      ['ready-mismatch', { class: 'failure', reason: 'protocol-violation' }],
    ];
    for (const [stop, expected] of stopRows) {
      for (const exit of ANY_EXITS) expect(classifyExit({ ...exit, stop }), `${stop} ${JSON.stringify(exit)}`).toEqual(expected);
    }
    const unrequested: [ExitInput, ExitClassification][] = [
      [{ code: 0, signal: null }, { class: 'unexpected-clean', reason: 'unexpected-clean' }],
      [{ code: 1, signal: null }, { class: 'failure', reason: 'failure' }],
      [{ code: 64, signal: null }, { class: 'failure', reason: 'failure' }],
      [{ code: 126, signal: null }, { class: 'failure', reason: 'failure' }],
      [{ code: 127, signal: null }, { class: 'failure', reason: 'failure' }],
      [{ code: 134, signal: null }, { class: 'failure', reason: 'failure' }],
      [{ code: 75, signal: null }, { class: 'lock-held', reason: 'lock-held' }],
      [{ code: 78, signal: null }, { class: 'config', reason: 'config' }],
      [{ code: null, signal: 'SIGKILL' }, { class: 'signal', reason: 'signal' }],
      [{ code: null, signal: 'SIGSEGV' }, { class: 'signal', reason: 'signal' }],
      [{ code: null, signal: 'SIGTERM' }, { class: 'signal', reason: 'signal' }],
    ];
    for (const [exit, expected] of unrequested) expect(classifyExit({ ...exit, stop: undefined }), JSON.stringify(exit)).toEqual(expected);
  });

  it('spawn and settings failures without a process are failures with their reason', () => {
    expect(failureWithoutProcess('spawn-failed')).toEqual({ class: 'failure', reason: 'spawn-failed' });
    expect(failureWithoutProcess('settings-read-failed')).toEqual({ class: 'failure', reason: 'settings-read-failed' });
    expect(decide(failureWithoutProcess('spawn-failed'), 0, () => 0.5)).toEqual({ next: 'backoff', delayMs: 250 });
    expect(decide(failureWithoutProcess('settings-read-failed'), 1, () => 0.5)).toEqual({ next: 'backoff', delayMs: 500 });
  });
});

describe('decideAfterExit', () => {
  it('shutdown stop: any exit is requested and stopped', () => {
    for (const exit of ANY_EXITS) {
      const classified = classifyExit({ ...exit, stop: 'shutdown' });
      expect(classified.class).toBe('requested');
      expect(decide(classified)).toEqual({ next: 'stopped' });
    }
  });

  it('startup-timeout stop is a failure with its reason', () => {
    for (const exit of ANY_EXITS) {
      const classified = classifyExit({ ...exit, stop: 'startup-timeout' });
      expect(classified).toEqual({ class: 'failure', reason: 'startup-timeout' });
      expect(decide(classified, 0, () => 0.5)).toEqual({ next: 'backoff', delayMs: 250 });
    }
  });

  it('ready-mismatch stop is a failure with reason protocol-violation', () => {
    for (const exit of ANY_EXITS) {
      const classified = classifyExit({ ...exit, stop: 'ready-mismatch' });
      expect(classified).toEqual({ class: 'failure', reason: 'protocol-violation' });
      expect(decide(classified, 2, () => 0.5)).toEqual({ next: 'backoff', delayMs: 1000 });
    }
  });

  it('0 unrequested backs off', () => {
    const classified = classifyExit({ code: 0, signal: null, stop: undefined });
    expect(classified).toEqual({ class: 'unexpected-clean', reason: 'unexpected-clean' });
    expect(decide(classified, 0, () => 0.5)).toEqual({ next: 'backoff', delayMs: 250 });
  });

  it('1 and 134 and 127 are failures', () => {
    for (const code of [1, 134, 127]) {
      const classified = classifyExit({ code, signal: null, stop: undefined });
      expect(classified).toEqual({ class: 'failure', reason: 'failure' });
      expect(decide(classified, 1, () => 0.5)).toEqual({ next: 'backoff', delayMs: 500 });
    }
  });

  it('signal unrequested is a signal failure', () => {
    const classified = classifyExit({ code: null, signal: 'SIGKILL', stop: undefined });
    expect(classified).toEqual({ class: 'signal', reason: 'signal' });
    expect(decide(classified, 0, () => 0.5)).toEqual({ next: 'backoff', delayMs: 250 });
  });

  it('75 yields waiting-lock only', () => {
    const classified = classifyExit({ code: 75, signal: null, stop: undefined });
    for (const failures of [0, 5, 100]) expect(decide(classified, failures, () => 0.999)).toEqual({ next: 'waiting-lock' });
  });

  it('79 is the retire exit: class retired, reason retired, and the child is never restarted (20.1)', () => {
    const exit = classifyExit({ code: EXIT_RETIRED, signal: null, stop: undefined });
    expect(EXIT_RETIRED).toBe(79);
    expect(exit).toEqual({ class: 'retired', reason: 'retired' });
    expect(decideAfterExit({ exit, consecutiveFailures: 0, policy: DEFAULT_RESTART_POLICY, random: () => 0.5 })).toEqual({ next: 'stopped' });
  });

  it('78 yields held-config', () => {
    const classified = classifyExit({ code: 78, signal: null, stop: undefined });
    for (const failures of [0, 5]) expect(decide(classified, failures, () => 0.999)).toEqual({ next: 'held-config' });
  });
});

describe('backoff', () => {
  it('backoff is full jitter, exponential, capped', () => {
    const expected = [499, 999, 1998, 3996, 7992, 15984, 29970, 29970, 29970];
    expected.forEach((delayMs, attempt) => {
      expect(backoffDelay({ consecutiveFailures: attempt, policy, random: () => 0.999 }), `attempt ${attempt}`).toBe(delayMs);
    });
    for (let attempt = 0; attempt <= 8; attempt += 1) expect(backoffDelay({ consecutiveFailures: attempt, policy, random: () => 0 })).toBe(100);
    expect(backoffDelay({ consecutiveFailures: 0, policy, random: () => 0.1 })).toBe(100);
    expect(backoffDelay({ consecutiveFailures: 0, policy, random: () => 0.3 })).toBe(150);
  });

  it('backoff cap', () => {
    expect(backoffDelay({ consecutiveFailures: 100, policy, random: () => 0.999999 })).toBeLessThanOrEqual(30_000);
    expect(backoffDelay({ consecutiveFailures: 100, policy, random: () => 0.5 })).toBe(15_000);
  });

  it('fast failures escalate to the caps', () => {
    const failure = classifyExit({ code: 1, signal: null, stop: undefined });
    const delays = [0, 1, 2, 3, 4].map((attempt) => decide(failure, attempt, () => 0.999));
    expect(delays).toEqual([499, 999, 1998, 3996, 7992].map((delayMs) => ({ next: 'backoff', delayMs })));
  });

  it('policy overrides apply to the backoff', () => {
    const custom = resolveRestartPolicy({ baseMs: 10, maxMs: 40, minMs: 5 });
    expect(custom).toEqual({ ...DEFAULT_RESTART_POLICY, baseMs: 10, maxMs: 40, minMs: 5 });
    expect(backoffDelay({ consecutiveFailures: 5, policy: custom, random: () => 0.5 })).toBe(20);
    expect(backoffDelay({ consecutiveFailures: 0, policy: custom, random: () => 0 })).toBe(5);
  });
});

describe('stop reason rank', () => {
  it('shutdown outranks the startup reasons', () => {
    expect(stopReasonRank('shutdown')).toBe(2);
    expect(stopReasonRank('startup-timeout')).toBe(1);
    expect(stopReasonRank('ready-mismatch')).toBe(1);
  });
});

describe('childRestartBoundMs', () => {
  const POLICIES = [DEFAULT_RESTART_POLICY, resolveRestartPolicy({ baseMs: 200, maxMs: 200, minMs: 200 }), resolveRestartPolicy({ baseMs: 50, maxMs: 10, minMs: 400 })];

  it('sums the stdio flush, the marker reap clock, the longest backoff and the startup timeout of the crashed child', () => {
    for (const restartPolicy of POLICIES) {
      expect(childRestartBoundMs({ policy: restartPolicy, startupTimeoutMs: STARTUP_TIMEOUT_MS, stdioFlushMs: STDIO_FLUSH_MS })).toBe(
        STDIO_FLUSH_MS + markerReapClockBoundMs(DAEMON_MARKER_KILL_GRACE_MS) + Math.max(restartPolicy.minMs, restartPolicy.maxMs) + STARTUP_TIMEOUT_MS,
      );
    }
  });

  it('covers every backoff delay the policy can draw', () => {
    for (const restartPolicy of POLICIES) {
      const bound = childRestartBoundMs({ policy: restartPolicy, startupTimeoutMs: 0, stdioFlushMs: 0 }) - markerReapClockBoundMs(DAEMON_MARKER_KILL_GRACE_MS);
      for (let attempt = 0; attempt <= 100; attempt += 1) {
        for (const draw of [0, 0.5, 0.999999]) expect(backoffDelay({ consecutiveFailures: attempt, policy: restartPolicy, random: () => draw })).toBeLessThanOrEqual(bound);
      }
    }
  });
});
