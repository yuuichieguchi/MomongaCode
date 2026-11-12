import { getRawAsset, isSea } from 'node:sea';
import { systemRandom } from '@momonga/foundation';
import type { KernelLockMechanism } from '@momonga/foundation';

type VerifyModule = typeof import('@momonga/verify');

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
