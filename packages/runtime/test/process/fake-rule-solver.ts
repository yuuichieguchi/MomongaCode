import type { RuleSolverHost, RuleSolverSource } from '../../src/process/rule-verifier.ts';

type Verifier = Awaited<ReturnType<RuleSolverHost['loadVerifier']>>;

export const FAKE_SOLVER_VERSION = 'fake-solver 1';

export const provedVerifier = {
  secretLocationsOf: () => [],
  ruleVerifyInputOf: (input: unknown) => input,
} as unknown as Verifier;

export const PROVED_THREAD_CODE = `
const { parentPort, workerData } = require('node:worker_threads');
parentPort.postMessage({ ok: true, verdict: { verdict: 'proved', solver: workerData.solverVersion, refuted: [], unknown: [], notProved: [] }, report: '' });
`;

export const REPORTING_THREAD_CODE = `
const { parentPort, workerData } = require('node:worker_threads');
parentPort.postMessage({ ok: true, verdict: { verdict: 'proved', solver: workerData.solverVersion, refuted: [], unknown: [], notProved: [] }, report: 'policy verification of ' + workerData.input.rules.length + ' rule(s)' });
`;

export const provedRuleSolver: RuleSolverSource = () => ({
  solverVersion: async () => FAKE_SOLVER_VERSION,
  loadVerifier: async () => provedVerifier,
  recipe: async () => ({ kind: 'installed', entry: '/nowhere/z3.js' }),
  threadCode: PROVED_THREAD_CODE,
});
