import path from 'node:path';
import { mapAsync, nodeFileSystem, protectedSetFor, sha256Hex } from '@momonga/foundation';
import type { Awaitable, Clock, LayoutLocks, MomongaPaths, UnixSocketPolicy, VerdictSubject } from '@momonga/foundation';
import { ShellNotFoundError, askedBy } from '@momonga/policy';
import type { PolicyHostFilesystem } from '@momonga/policy';
import { createPolicyFilesystem, resolveBashPath } from '@momonga/tools';
import type { ShellHost } from '@momonga/tools';
import type { RuleVerification, RuleVerifierPort } from '../ports.ts';
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

export type RuleSolverSource = (paths: Pick<MomongaPaths, 'executables'>, locks: LayoutLocks) => RuleSolverHost;

export const RULE_VERIFY_LOAD_ALLOWANCE_MS = 10_000;

const INSTALLED_SOLVER_CODE: readonly string[] = ['z3-built.js', 'z3-built.wasm'];

const installedIdentityOf = async (entry: string): Promise<string> => {
  const files = [entry, ...INSTALLED_SOLVER_CODE.map((name) => path.join(path.dirname(entry), name))];
  const hashes = await mapAsync(files, async (file) => sha256Hex(await nodeFileSystem.readFile(file)));
  return `z3 ${sha256Hex(JSON.stringify(hashes))}`;
};

export const installedRuleSolver = (from: string): RuleSolverHost => {
  const loadVerifier = (): Promise<VerifyModule> => import('@momonga/verify');
  let identity: Promise<string> | undefined;
  return {
    loadVerifier,
    solverVersion: () => (identity ??= loadVerifier().then((verifier) => installedIdentityOf(verifier.resolveInstalledZ3(from)))),
    recipe: async (verifier) => ({ kind: 'installed', entry: verifier.resolveInstalledZ3(from) }),
  };
};

export type RuleVerifierDeps = {
  host: RuleSolverHost;
  fs: PolicyHostFilesystem;
  paths: Pick<MomongaPaths, 'home' | 'root' | 'keychains'>;
  timers: ServiceTimers;
  bashPath: () => Awaitable<string>;
  clock: Clock;
  budgetMs: number;
  startBoundMs: number;
};

export const createRuleVerifier = ({ host, fs: policyFilesystem, paths, timers, bashPath, clock, budgetMs, startBoundMs }: RuleVerifierDeps): RuleVerifierPort => {
  const foundBashPath = async (): Promise<string | undefined> => {
    try {
      return await bashPath();
    } catch (error) {
      if (error instanceof ShellNotFoundError) return undefined;
      throw error;
    }
  };
  const prepared = new WeakMap<object, UnixSocketPolicy>();
  const preparedInput = (input: VerdictSubject): RuleVerifyInput => {
    if (!prepared.has(input)) throw new Error('the rule verifier was given an input it did not prepare');
    return input as RuleVerifyInput;
  };
  const socketsOf = (input: VerdictSubject): UnixSocketPolicy => {
    const sockets = prepared.get(input);
    if (sockets === undefined) throw new Error('the rule verifier was given an input it did not prepare');
    return sockets;
  };
  const report = async (input: VerdictSubject, signal: AbortSignal): Promise<RuleVerification> => {
    const request = preparedInput(input);
    signal.throwIfAborted();
    const verifier = await host.loadVerifier();
    return verifyInThread(
      { code: host.threadCode ?? RULE_VERIFIER_THREAD_CODE, timers, startBoundMs },
      { input: request, unixSockets: socketsOf(input), solver: await host.recipe(verifier), solverVersion: await host.solverVersion(), budgetMs, askedAtMs: clock.now(), platform: policyFilesystem.platform, bashPath: await foundBashPath() },
      signal,
    );
  };
  return {
    solverVersion: host.solverVersion,
    inputOf: async ({ secrets, mandateChecks, ...request }, signal) => {
      const verifier = await host.loadVerifier();
      const subject = verifier.ruleVerifyInputOf({
        ...request,
        protectedSet: await protectedSetFor(request.roots, askedBy(policyFilesystem, signal)),
        secretLocations: verifier.secretLocationsOf(paths, secrets),
        deniedLocations: verifier.secretLocationsOf(paths, []),
      });
      const input = mandateChecks === undefined ? subject : { ...subject, ...mandateChecks };
      prepared.set(input, request.unixSockets);
      return input;
    },
    needsVerdict: async (input) => (await host.loadVerifier()).needsVerdict(preparedInput(input)),
    report,
    verify: async (input, signal) => (await report(input, signal)).verdict,
  };
};

export type ProductRuleVerifierDeps = {
  solver: RuleSolverSource | undefined;
  paths: Pick<MomongaPaths, 'home' | 'root' | 'keychains' | 'executables'>;
  locks: LayoutLocks;
  timers: ServiceTimers;
  shellHost: Pick<ShellHost, 'platform' | 'isExecutable'>;
  env: NodeJS.ProcessEnv;
  clock: Clock;
  budgetMs: number;
};

export const productRuleVerifier = ({ solver, paths, locks, timers, shellHost, env, clock, budgetMs }: ProductRuleVerifierDeps): RuleVerifierPort =>
  createRuleVerifier({
    host: solver === undefined ? installedRuleSolver(import.meta.url) : solver(paths, locks),
    fs: createPolicyFilesystem(),
    paths,
    timers,
    bashPath: () => resolveBashPath(shellHost.platform, { isExecutable: shellHost.isExecutable, env }),
    clock,
    budgetMs,
    startBoundMs: RULE_VERIFY_LOAD_ALLOWANCE_MS,
  });
