import path from 'node:path';
import { nodeFileSystem, parseOutsideJson, protectedSetFor } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { askedBy } from '@momonga/policy';
import type { PolicyHostFilesystem } from '@momonga/policy';
import { RULE_VERIFY_BUDGET_MS } from '@momonga/protocol';
import type { RuleVerifierPort } from '../ports.ts';
import type { ServiceTimers } from '../service/timers.ts';
import { RULE_VERIFIER_THREAD_CODE } from './rule-verifier-thread-code.generated.ts';
import { verifyInThread } from './rule-verifier-thread-client.ts';
import type { RuleSolverRecipe } from './rule-verifier-thread.ts';

type VerifyModule = typeof import('@momonga/verify');
type RuleVerifyInput = Parameters<VerifyModule['ruleVerifyInputOf']>[0];

export type RuleSolverHost = {
  solverVersion(): Promise<string>;
  loadVerifier(): Promise<VerifyModule>;
  recipe(verifier: VerifyModule): Promise<RuleSolverRecipe>;
  threadCode?: string;
};

export type RuleSolverSource = (paths: Pick<MomongaPaths, 'executables'>) => RuleSolverHost;

export const RULE_VERIFY_LOAD_ALLOWANCE_MS = 10_000;

const INSTALLED_PACKAGE = `${path.sep}node_modules${path.sep}z3-solver${path.sep}`;

const installedVersionOf = async (entry: string): Promise<string> => {
  const at = entry.lastIndexOf(INSTALLED_PACKAGE);
  if (at < 0) throw new Error(`the Z3 solver at ${entry} is not inside a z3-solver package`);
  const manifest: unknown = parseOutsideJson(new TextDecoder().decode(await nodeFileSystem.readFile(path.join(entry.slice(0, at + INSTALLED_PACKAGE.length), 'package.json'))));
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
    recipe: async (verifier) => ({ kind: 'installed', entry: verifier.resolveInstalledZ3(from) }),
  };
};

export type RuleVerifierDeps = {
  host: RuleSolverHost;
  fs: PolicyHostFilesystem;
  paths: Pick<MomongaPaths, 'root' | 'keychains'>;
  timers: ServiceTimers;
};

export const createRuleVerifier = ({ host, fs: policyFilesystem, paths, timers }: RuleVerifierDeps): RuleVerifierPort => {
  const prepared = new WeakSet<object>();
  const preparedInput = (input: unknown): RuleVerifyInput => {
    if (typeof input !== 'object' || input === null || !prepared.has(input)) throw new Error('the rule verifier was given an input it did not prepare');
    return input as RuleVerifyInput;
  };
  return {
    solverVersion: host.solverVersion,
    inputOf: async (request, signal) => {
      const verifier = await host.loadVerifier();
      const input = verifier.ruleVerifyInputOf({
        ...request,
        protectedSet: await protectedSetFor(request.roots, askedBy(policyFilesystem, signal)),
        secretLocations: verifier.secretLocationsOf(request.home, paths, []),
      });
      prepared.add(input);
      return input;
    },
    verify: async (input, signal) => {
      const request = preparedInput(input);
      signal.throwIfAborted();
      const verifier = await host.loadVerifier();
      return verifyInThread(
        { code: host.threadCode ?? RULE_VERIFIER_THREAD_CODE, timers, loadAllowanceMs: RULE_VERIFY_LOAD_ALLOWANCE_MS },
        { input: request, solver: await host.recipe(verifier), solverVersion: await host.solverVersion(), budgetMs: RULE_VERIFY_BUDGET_MS },
        signal,
      );
    },
  };
};
