import type { RuleVerdict } from '@momonga/protocol';
import { needsVerdict } from '@momonga/verify';
import type { RuleVerifierPort, RuleVerifyRequest } from '../../src/ports.ts';

export const FAKE_SOLVER_VERSION = 'fake-solver 1';

export const FAKE_PROVED: RuleVerdict = { verdict: 'proved', solver: FAKE_SOLVER_VERSION, refuted: [], unknown: [], notProved: ['What an arbitrary shell command does when it runs.'] };

export type FakeRuleVerifier = RuleVerifierPort & { answer: (input: unknown, signal: AbortSignal) => RuleVerdict | Promise<RuleVerdict>; verified: unknown[]; requests: RuleVerifyRequest[]; settled(): Promise<void> };

export const createFakeRuleVerifier = (): FakeRuleVerifier => {
  const answered: Promise<RuleVerdict>[] = [];
  const fake: FakeRuleVerifier = {
    solverVersion: async () => FAKE_SOLVER_VERSION,
    answer: () => FAKE_PROVED,
    verified: [],
    requests: [],
    settled: async () => {
      await Promise.allSettled(answered);
    },
    inputOf: async (request) => {
      fake.requests.push(request);
      return { ...request, rules: request.rules.map((rule) => ({ text: rule.text, effect: rule.effect })), protectedSet: { paths: [], lexicalPaths: [], literals: [] }, secretLocations: [], deniedLocations: [] };
    },
    verify: async (input, signal) => {
      fake.verified.push(input);
      const answer = Promise.resolve(fake.answer(input, signal));
      answered.push(answer);
      return answer;
    },
    needsVerdict: async (input) => needsVerdict({ rules: input.rules as never }),
    report: async (input, signal) => ({ verdict: await fake.verify(input, signal), report: 'the report of the fake verifier', findings: { exitCode: 0 } }),
  };
  return fake;
};
