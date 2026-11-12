import { getRawAsset, isSea } from 'node:sea';
import { systemRandom } from '@momonga/foundation';
import type { KernelLockMechanism, MomongaPaths } from '@momonga/foundation';
import type { CliPorts } from '../ports.ts';

export type VerifyModule = typeof import('@momonga/verify');
export type VerifyRequestShape = Parameters<VerifyModule['verifyPermissions']>[1];
export type SolverEngine = Awaited<ReturnType<VerifyModule['openZ3']>>;

export type PolicyVerifyHost = {
  loadVerifier(): Promise<VerifyModule>;
  solverVersion(verifier: VerifyModule): Promise<string>;
  loadPolicyFilesystem(): Promise<VerifyRequestShape['fs']>;
  loadOperationCatalogue?(): Promise<{ supersededForms: NonNullable<VerifyRequestShape['supersededForms']>; alwaysOperations: readonly string[] }>;
  openSolver(verifier: VerifyModule): Promise<SolverEngine>;
};

const bundledManifestOf = (verifier: VerifyModule): ReturnType<VerifyModule['parseZ3Manifest']> =>
  verifier.parseZ3Manifest(new TextDecoder().decode(getRawAsset(verifier.Z3_MANIFEST_ASSET)));

const bundledVersionOf = (verifier: VerifyModule): string => `z3 ${bundledManifestOf(verifier).contentHash}`;

const bundledZ3Of = (verifier: VerifyModule, executablesRoot: string, lock: KernelLockMechanism, random: () => number): ReturnType<VerifyModule['ensureBundledZ3']> =>
  verifier.ensureBundledZ3({
    asset: (name) => new Uint8Array(getRawAsset(name)),
    executablesRoot,
    random,
    lock,
    files: verifier.nodeDistributionFiles,
  });

export const nodePolicyVerifyHost = (ports: Pick<CliPorts, 'random'>, paths: Pick<MomongaPaths, 'executables'>, lock: KernelLockMechanism): PolicyVerifyHost => ({
  loadVerifier: () => import('@momonga/verify'),
  loadPolicyFilesystem: async () => (await import('@momonga/runtime')).createPolicyFilesystem(),
  loadOperationCatalogue: async () => (await import('@momonga/runtime')).operationCatalogueFacts(),
  solverVersion: async (verifier) => {
    if (isSea()) return bundledVersionOf(verifier);
    return (await import('@momonga/runtime')).installedRuleSolver(import.meta.url).solverVersion();
  },
  openSolver: async (verifier) => {
    if (!isSea()) return verifier.openZ3({ entry: verifier.resolveInstalledZ3(import.meta.url) });
    return verifier.openZ3(await bundledZ3Of(verifier, paths.executables, lock, ports.random));
  },
});

type RuntimeEntry = typeof import('@momonga/runtime/entry');
type RuleSolverSource = NonNullable<Parameters<RuntimeEntry['runRuntimeEntry']>[1]['ruleSolver']>;

export const embeddedRuleSolver = (): RuleSolverSource | undefined => {
  if (!isSea()) return undefined;
  return (paths, locks) => {
    const loadVerifier = (): Promise<VerifyModule> => import('@momonga/verify');
    return {
      loadVerifier,
      solverVersion: async () => bundledVersionOf(await loadVerifier()),
      recipe: async (verifier) => {
        const bundled = await bundledZ3Of(verifier, paths.executables, locks.mechanism, systemRandom.float);
        return { kind: 'bundled', entry: bundled.entry, wasmBinary: bundled.wasmBinary };
      },
    };
  };
};
