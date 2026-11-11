import type { RuleSolverHost, RuleSolverSource } from '../../src/process/rule-verifier.ts';

type Verifier = Awaited<ReturnType<RuleSolverHost['loadVerifier']>>;

export const FAKE_SOLVER_VERSION = 'fake-solver 1';

export const provedVerifier = {
  secretLocationsOf: () => [],
  ruleVerifyInputOf: (input: unknown) => input,
  needsVerdict: () => true,
} as unknown as Verifier;

export const PROVED_THREAD_CODE = `
const { parentPort, workerData } = require('node:worker_threads');
parentPort.postMessage({ entered: true });
parentPort.postMessage({ ok: true, verdict: { verdict: 'proved', solver: workerData.solverVersion, refuted: [], unknown: [], notProved: [] }, report: '', findings: { exitCode: 0 } });
`;

export const REPORTING_THREAD_CODE = `
const { parentPort, workerData } = require('node:worker_threads');
parentPort.postMessage({ entered: true });
parentPort.postMessage({ ok: true, verdict: { verdict: 'proved', solver: workerData.solverVersion, refuted: [], unknown: [], notProved: [] }, report: 'policy verification of ' + workerData.input.rules.length + ' rule(s)', findings: { exitCode: 0 } });
`;

export const BUDGET_THREAD_CODE = `
const { parentPort, workerData } = require('node:worker_threads');
parentPort.postMessage({ entered: true });
parentPort.postMessage({ ok: true, verdict: { verdict: 'proved', solver: workerData.solverVersion, refuted: [], unknown: [], notProved: [] }, report: 'budget ' + workerData.budgetMs, findings: { exitCode: 0 } });
`;

export const provedRuleSolver: RuleSolverSource = () => ({
  solverVersion: async () => FAKE_SOLVER_VERSION,
  loadVerifier: async () => provedVerifier,
  recipe: async () => ({ kind: 'installed', entry: '/nowhere/z3.js' }),
  threadCode: PROVED_THREAD_CODE,
});
