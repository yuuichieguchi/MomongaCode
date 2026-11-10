import { getRawAsset, isSea } from 'node:sea';
import type { MomongaPaths } from '@momonga/foundation';
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

export const nodePolicyVerifyHost = (ports: Pick<CliPorts, 'random'>, paths: Pick<MomongaPaths, 'executables'>): PolicyVerifyHost => ({
  loadVerifier: () => import('@momonga/verify'),
  loadPolicyFilesystem: async () => (await import('@momonga/runtime')).createPolicyFilesystem(),
  loadOperationCatalogue: async () => (await import('@momonga/runtime')).operationCatalogueFacts(),
  solverVersion: async (verifier) => {
    if (isSea()) return bundledVersionOf(verifier);
    return (await import('@momonga/runtime')).installedRuleSolver(import.meta.url).solverVersion();
  },
  openSolver: async (verifier) => {
    if (!isSea()) return verifier.openZ3({ entry: verifier.resolveInstalledZ3(import.meta.url) });
    return verifier.openZ3(
      await verifier.ensureBundledZ3({
        asset: (name) => new Uint8Array(getRawAsset(name)),
        executablesRoot: paths.executables,
        random: ports.random,
        files: verifier.nodeDistributionFiles,
      }),
    );
  },
});

type RuntimeEntry = typeof import('@momonga/runtime/entry');
type RuleSolverSource = NonNullable<Parameters<RuntimeEntry['runRuntimeEntry']>[1]['ruleSolver']>;

export const embeddedRuleSolver = (): RuleSolverSource | undefined => {
  if (!isSea()) return undefined;
  return (paths) => {
    const loadVerifier = (): Promise<VerifyModule> => import('@momonga/verify');
    return {
      loadVerifier,
      solverVersion: async () => bundledVersionOf(await loadVerifier()),
      recipe: async (verifier) => {
        const manifest = bundledManifestOf(verifier);
        const names = [verifier.Z3_MANIFEST_ASSET, ...manifest.files.map((file) => file.name), manifest.wasm.asset];
        return { kind: 'bundled', executablesRoot: paths.executables, assets: Object.fromEntries(names.map((name) => [name, new Uint8Array(getRawAsset(name))])) };
      },
    };
  };
};
