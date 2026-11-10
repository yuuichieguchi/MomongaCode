import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { systemRandom } from '@momonga/foundation';
import type { RuleVerdict } from '@momonga/protocol';
import { createPolicyFilesystem } from '@momonga/tools';

type VerifyModule = typeof import('@momonga/verify');
type RuleVerifyInput = Parameters<VerifyModule['ruleVerifyInputOf']>[0];
type SolverSource = Parameters<VerifyModule['openZ3']>[0];

export type RuleSolverRecipe =
  | { readonly kind: 'installed'; readonly entry: string }
  | { readonly kind: 'bundled'; readonly executablesRoot: string; readonly assets: Readonly<Record<string, Uint8Array>> };

export type RuleVerifyJob = {
  readonly input: RuleVerifyInput;
  readonly solver: RuleSolverRecipe;
  readonly solverVersion: string;
  readonly budgetMs: number;
};

export type RuleVerifyReply = { readonly ok: true; readonly verdict: RuleVerdict } | { readonly ok: false; readonly reason: string };

const sourceOf = async (verifier: VerifyModule, recipe: RuleSolverRecipe): Promise<SolverSource> => {
  if (recipe.kind === 'installed') return { entry: recipe.entry };
  return verifier.ensureBundledZ3({
    asset: (name) => {
      const bytes = recipe.assets[name];
      if (bytes === undefined) throw new Error(`the verification thread was not given the Z3 asset ${name}`);
      return bytes;
    },
    executablesRoot: recipe.executablesRoot,
    random: systemRandom.float,
    files: verifier.nodeDistributionFiles,
  });
};

export const runRuleVerifyJob = async (job: RuleVerifyJob): Promise<RuleVerdict> => {
  const verifier = await import('@momonga/verify');
  const engine = await verifier.openZ3(await sourceOf(verifier, job.solver));
  try {
    const report = await verifier.verifyPermissions(engine.api, { ...job.input, fs: createPolicyFilesystem(), exemptDirectory: null, budgetMs: job.budgetMs });
    return verifier.verdictOfReport(report, job.solverVersion);
  } finally {
    await engine.close();
  }
};

const isRuleVerifyJob = (value: unknown): value is RuleVerifyJob =>
  typeof value === 'object' && value !== null && 'input' in value && 'solver' in value && 'solverVersion' in value && typeof value.solverVersion === 'string' && 'budgetMs' in value && typeof value.budgetMs === 'number';

if (!isMainThread && parentPort !== null && isRuleVerifyJob(workerData)) {
  const port = parentPort;
  const post = (reply: RuleVerifyReply): void => port.postMessage(reply);
  void runRuleVerifyJob(workerData).then(
    (verdict) => post({ ok: true, verdict }),
    (error: unknown) => post({ ok: false, reason: error instanceof Error ? error.message : String(error) }),
  );
}
