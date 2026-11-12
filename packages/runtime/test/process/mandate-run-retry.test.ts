import { describe, expect, it } from 'vitest';
import { pollUntil } from '@momonga/testkit';
import type { RuleVerdict } from '@momonga/protocol';
import { mandateRunVerification } from '../../src/process/folder-verification.ts';
import type { RuleVerifierPort } from '../../src/ports.ts';
import { RuleVerificationFailure } from '../../src/process/rule-verifier-thread-client.ts';

const SOLVER = 'z3-fake';

const refuted: RuleVerdict = {
  verdict: 'refuted',
  solver: SOLVER,
  refuted: [{ property: 'superseded-forms', subject: 'the allow rule Bash(git push:*) of the mandate', message: 'it admits git push' }],
  unknown: [],
  notProved: [],
};

const RETRY_BOUND_MS = 10_000;

const verifierFailingOnce = (): RuleVerifierPort & { calls: number } => {
  const verifier = {
    calls: 0,
    solverVersion: async () => SOLVER,
    inputOf: async (request: unknown) => request as never,
    needsVerdict: async () => true,
    verify: async (): Promise<RuleVerdict> => {
      verifier.calls += 1;
      if (verifier.calls === 1) throw new RuleVerificationFailure('the verification thread did not start within 1 ms');
      return refuted;
    },
    report: async () => {
      throw new Error('this test asks for no report');
    },
  };
  return verifier;
};

describe('a mandate verdict that is unknown at creation is retried in the background', () => {
  it('answers unknown at once, retries behind it, stores the final verdict under the creation key, and answers that verdict next time', async () => {
    const verifier = verifierFailingOnce();
    const stored = new Map<string, RuleVerdict>();
    const verify = mandateRunVerification({
      verifier,
      ruleVerdicts: { get: (fingerprint) => (stored.has(fingerprint) ? { verdict: stored.get(fingerprint) as RuleVerdict } : undefined), put: (fingerprint, verdict) => void stored.set(fingerprint, verdict) },
      home: '/',
      sessionsRoot: '/tmp/sessions',
      folder: async () => ({ rules: [], additionalDirectories: [], enforcement: 'exact-paths', unixSockets: { kind: 'limited', allowed: [] } }),
      catalogue: () => ({ supersededForms: [], alwaysOperations: [] }),
      retrySignal: new AbortController().signal,
      onRetryFailure: (error) => {
        throw error;
      },
    });
    const request = { cwd: '/', mode: 'manual' as const, mandate: { scope: { allow: ['Bash(git push:*)'], ask: [], deny: [] } } };

    const first = await verify(request, new AbortController().signal);
    expect(first.verdict).toBe('unknown');

    const second = await verify(request, new AbortController().signal);
    expect(second.verdict).toBe('unknown');
    await pollUntil(() => stored.size === 1, { description: 'the retried verdict to be stored', boundMs: RETRY_BOUND_MS });
    expect([...stored.values()]).toEqual([refuted]);
    expect(await verify(request, new AbortController().signal)).toEqual(refuted);
    expect(verifier.calls).toBe(2);
  });
});
