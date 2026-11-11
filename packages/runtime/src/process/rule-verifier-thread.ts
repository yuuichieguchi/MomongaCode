import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { systemClock } from '@momonga/foundation';
import type { Clock, UnixSocketPolicy } from '@momonga/foundation';
import type { RuleVerdict, RuleVerdictPhase } from '@momonga/protocol';
import { ShellNotFoundError, createHostFilesystem, nodeGlobPorts } from '@momonga/policy';

type VerifyModule = typeof import('@momonga/verify');
type RuleVerifyInput = Parameters<VerifyModule['ruleVerifyInputOf']>[0];
type SolverSource = Parameters<VerifyModule['openZ3']>[0];

export type RuleSolverRecipe =
  | { readonly kind: 'installed'; readonly entry: string }
  | { readonly kind: 'bundled'; readonly entry: string; readonly wasmBinary: Uint8Array };

export type RuleVerifyJob = {
  readonly input: RuleVerifyInput;
  readonly unixSockets: UnixSocketPolicy;
  readonly solver: RuleSolverRecipe;
  readonly solverVersion: string;
  readonly budgetMs: number;
  readonly askedAtMs: number;
  readonly platform: NodeJS.Platform;
  readonly bashPath: string | undefined;
};

export type RuleVerification = { readonly verdict: RuleVerdict; readonly report: string };

export type RuleVerifyReply = ({ readonly ok: true } & RuleVerification) | { readonly ok: false; readonly reason: string };

const sourceOf = async (verifier: VerifyModule, recipe: RuleSolverRecipe): Promise<SolverSource> => {
  if (recipe.kind === 'installed') return { entry: recipe.entry };
  return { entry: recipe.entry, wasmBinary: recipe.wasmBinary };
};

const bashPathOf = (job: RuleVerifyJob): string => {
  if (job.bashPath === undefined) throw new ShellNotFoundError('the runtime found no bash for the verification');
  return job.bashPath;
};

export type RuleVerifyAbort = { readonly abort: string };

export type HostMarks = { askedAtMs: number; enteredAtMs: number; loadedAtMs: number; instantiatedAtMs: number };

export const hostPhasesOf = ({ askedAtMs, enteredAtMs, loadedAtMs, instantiatedAtMs }: HostMarks): RuleVerdictPhase[] => [
  { phase: 'thread-start', ms: enteredAtMs - askedAtMs },
  { phase: 'load', ms: loadedAtMs - enteredAtMs },
  { phase: 'instantiate', ms: instantiatedAtMs - loadedAtMs },
];

export const runRuleVerifyJob = async (job: RuleVerifyJob, { signal, clock }: { signal: AbortSignal; clock: Clock }): Promise<RuleVerification> => {
  const enteredAtMs = clock.now();
  signal.throwIfAborted();
  const verifier = await import('@momonga/verify');
  const source = await sourceOf(verifier, job.solver);
  const loadedAtMs = clock.now();
  const engine = await verifier.openZ3(source);
  const hostPhases = hostPhasesOf({ askedAtMs: job.askedAtMs, enteredAtMs, loadedAtMs, instantiatedAtMs: clock.now() });
  try {
    const report = await verifier.verifyPermissions(engine.api, {
      ...job.input,
      fs: createHostFilesystem(job.platform, () => bashPathOf(job), process.env, nodeGlobPorts()),
      budgetMs: job.budgetMs,
      signal,
      clock,
      hostPhases,
      unixSockets: job.unixSockets,
    });
    return { verdict: verifier.verdictOfReport(report, job.solverVersion), report: verifier.formatReport(report) };
  } finally {
    await engine.close();
  }
};

const isRuleVerifyJob = (value: unknown): value is RuleVerifyJob =>
  typeof value === 'object' && value !== null && 'input' in value && 'solver' in value && 'solverVersion' in value && typeof value.solverVersion === 'string' && 'budgetMs' in value && typeof value.budgetMs === 'number' && 'askedAtMs' in value && typeof value.askedAtMs === 'number' && 'platform' in value && typeof value.platform === 'string';

const isRuleVerifyAbort = (value: unknown): value is RuleVerifyAbort => typeof value === 'object' && value !== null && 'abort' in value && typeof value.abort === 'string';

if (!isMainThread && parentPort !== null && isRuleVerifyJob(workerData)) {
  const port = parentPort;
  const asker = new AbortController();
  port.on('message', (message: unknown) => {
    if (isRuleVerifyAbort(message)) asker.abort(new Error(message.abort));
  });
  const post = (reply: RuleVerifyReply): void => port.postMessage(reply);
  void runRuleVerifyJob(workerData, { signal: asker.signal, clock: systemClock }).then(
    (verification) => post({ ok: true, ...verification }),
    (error: unknown) => post({ ok: false, reason: error instanceof Error ? error.message : String(error) }),
  );
}
