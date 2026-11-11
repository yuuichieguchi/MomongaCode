import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({ signals: [] as AbortSignal[] }));

vi.mock('@momonga/verify', () => ({
  openZ3: async () => ({ api: {}, close: async () => undefined }),
  verifyPermissions: async (_api: unknown, input: { signal: AbortSignal }) => {
    seen.signals.push(input.signal);
    return {};
  },
  verdictOfReport: (_report: unknown, solver: string) => ({ verdict: 'proved', solver, refuted: [], unknown: [], notProved: [] }),
}));

const { RULE_VERIFY_ABORT, runRuleVerifyJob, threadSignalOf } = await import('../../src/process/rule-verifier-thread.ts');

const JOB = { input: {} as never, solver: { kind: 'installed', entry: '/opt/z3' }, solverVersion: 'z3-test', budgetMs: 1000 } as const;

describe('the verification thread works under the signal of the operation that asked', () => {
  it('gives the verifier the signal it was given, never a signal of the thread lifetime', async () => {
    const asker = new AbortController();
    await runRuleVerifyJob(JOB, asker.signal);
    expect(seen.signals.at(-1)).toBe(asker.signal);
  });

  it('ends the signal of the thread when the asker sends the abort message', () => {
    const port = new EventEmitter();
    const signal = threadSignalOf(port);
    port.emit('message', { kind: 'other' });
    expect(signal.aborted).toBe(false);
    port.emit('message', RULE_VERIFY_ABORT);
    expect(signal.aborted).toBe(true);
  });
});
