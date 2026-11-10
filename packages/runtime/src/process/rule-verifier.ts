import path from 'node:path';
import { nodeFileSystem, protectedSetFor } from '@momonga/foundation';
import type { MomongaPaths, ProtectedSet } from '@momonga/foundation';
import type { PolicyHostFilesystem } from '@momonga/policy';
import { RULE_VERIFY_BUDGET_MS } from '@momonga/protocol';
import type { RuleVerdict } from '@momonga/protocol';
import type { RuleVerifierPort, RuleVerifyRequest } from '../ports.ts';

type VerifyModule = typeof import('@momonga/verify');
type SolverEngine = Awaited<ReturnType<VerifyModule['openZ3']>>;
type VerificationReport = Awaited<ReturnType<VerifyModule['verifyPermissions']>>;
type SecretLocations = ReturnType<VerifyModule['secretLocationsOf']>;

export type RuleSolverHost = {
  solverVersion(): Promise<string>;
  loadVerifier(): Promise<VerifyModule>;
  openSolver(verifier: VerifyModule): Promise<SolverEngine>;
};

export type RuleSolverSource = (paths: Pick<MomongaPaths, 'executables'>) => RuleSolverHost;

const INSTALLED_PACKAGE = `${path.sep}node_modules${path.sep}z3-solver${path.sep}`;

const installedVersionOf = async (entry: string): Promise<string> => {
  const at = entry.lastIndexOf(INSTALLED_PACKAGE);
  if (at < 0) throw new Error(`the Z3 solver at ${entry} is not inside a z3-solver package`);
  const manifest: unknown = JSON.parse(new TextDecoder().decode(await nodeFileSystem.readFile(path.join(entry.slice(0, at + INSTALLED_PACKAGE.length), 'package.json'))));
  if (typeof manifest !== 'object' || manifest === null || !('version' in manifest) || typeof manifest.version !== 'string') {
    throw new Error(`the z3-solver package of ${entry} states no version`);
  }
  return `z3-solver ${manifest.version}`;
};

export const installedRuleSolver = (from: string): RuleSolverHost => {
  const loadVerifier = (): Promise<VerifyModule> => import('@momonga/verify');
  return {
    loadVerifier,
    solverVersion: async () => installedVersionOf((await loadVerifier()).resolveInstalledZ3(from)),
    openSolver: (verifier) => verifier.openZ3({ entry: verifier.resolveInstalledZ3(from) }),
  };
};

type VerifyInput = RuleVerifyRequest & { protectedSet: ProtectedSet; secretLocations: SecretLocations };

export const verdictOfReport = (verifier: Pick<VerifyModule, 'describeWitness'>, report: VerificationReport, solver: string): RuleVerdict => {
  const refuted = report.results.flatMap((result) =>
    result.verdict.status === 'refuted'
      ? result.verdict.findings.map((finding) => ({
          property: result.id,
          subject: finding.subject,
          message: finding.message,
          ...(finding.counterexample === undefined ? {} : { counterexample: verifier.describeWitness(finding.counterexample.witness) }),
        }))
      : [],
  );
  const unknown = [
    ...report.results.flatMap((result) => (result.verdict.status === 'unknown' ? [{ property: result.id, reason: result.verdict.reason }] : [])),
    ...report.mismatches.map((mismatch) => ({
      property: mismatch.property,
      reason: `the model and the decision code disagree on ${verifier.describeWitness(mismatch.counterexample.witness)}`,
    })),
  ];
  return { verdict: refuted.length > 0 ? 'refuted' : unknown.length > 0 ? 'unknown' : 'proved', solver, refuted, unknown, notProved: [...report.outsideProof] };
};

export type RuleVerifierDeps = {
  host: RuleSolverHost;
  fs: PolicyHostFilesystem;
  paths: Pick<MomongaPaths, 'root' | 'keychains'>;
};

export const createRuleVerifier = ({ host, fs: policyFilesystem, paths }: RuleVerifierDeps): RuleVerifierPort => {
  const prepared = new WeakSet<object>();
  const preparedInput = (input: unknown): VerifyInput => {
    if (typeof input !== 'object' || input === null || !prepared.has(input)) throw new Error('the rule verifier was given an input it did not prepare');
    return input as VerifyInput;
  };
  return {
    solverVersion: host.solverVersion,
    inputOf: async (request) => {
      const verifier = await host.loadVerifier();
      const input: VerifyInput = {
        ...request,
        protectedSet: protectedSetFor(request.roots, policyFilesystem),
        secretLocations: verifier.secretLocationsOf(request.home, paths, []),
      };
      prepared.add(input);
      return input;
    },
    verify: async (input, signal) => {
      const request = preparedInput(input);
      signal.throwIfAborted();
      const verifier = await host.loadVerifier();
      const solver = await host.solverVersion();
      const engine = await host.openSolver(verifier);
      try {
        const report = await verifier.verifyPermissions(engine.api, { ...request, fs: policyFilesystem, exemptDirectory: null, budgetMs: RULE_VERIFY_BUDGET_MS });
        return verdictOfReport(verifier, report, solver);
      } finally {
        await engine.close();
      }
    },
  };
};
