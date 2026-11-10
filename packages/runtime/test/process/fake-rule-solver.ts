import type { RuleSolverHost, RuleSolverSource } from '../../src/process/rule-verifier.ts';

type Verifier = Awaited<ReturnType<RuleSolverHost['loadVerifier']>>;

const provedVerifier = {
  describeWitness: () => 'no witness',
  secretLocationsOf: () => [],
  verifyPermissions: async () => ({ mode: 'manual', ruleCount: 0, solver: 'fake', results: [], mismatches: [], outsideProof: [], exitCode: 0 }),
} as unknown as Verifier;

export const provedRuleSolver: RuleSolverSource = () => ({
  solverVersion: async () => 'fake-solver 1',
  loadVerifier: async () => provedVerifier,
  openSolver: async () => ({ api: {} as never, close: async () => undefined }),
});
