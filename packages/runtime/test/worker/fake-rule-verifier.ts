import type { RuleVerdict } from '@momonga/protocol';
import type { RuleVerifierPort, RuleVerifyRequest } from '../../src/ports.ts';

export const FAKE_SOLVER_VERSION = 'fake-solver 1';

export const FAKE_PROVED: RuleVerdict = { verdict: 'proved', solver: FAKE_SOLVER_VERSION, refuted: [], unknown: [], notProved: ['What an arbitrary shell command does when it runs.'] };

export type FakeRuleVerifier = RuleVerifierPort & { answer: (input: unknown, signal: AbortSignal) => RuleVerdict | Promise<RuleVerdict>; verified: unknown[]; requests: RuleVerifyRequest[] };

export const createFakeRuleVerifier = (): FakeRuleVerifier => {
  const fake: FakeRuleVerifier = {
    solverVersion: async () => FAKE_SOLVER_VERSION,
    answer: () => FAKE_PROVED,
    verified: [],
    requests: [],
    inputOf: async (request) => {
      fake.requests.push(request);
      return { ...request, rules: request.rules.map((rule) => ({ text: rule.text, effect: rule.effect })), protectedSet: [], secretLocations: [] };
    },
    verify: async (input, signal) => {
      fake.verified.push(input);
      return fake.answer(input, signal);
    },
  };
  return fake;
};
