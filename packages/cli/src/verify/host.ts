import { getRawAsset, isSea } from 'node:sea';

type VerifyModule = typeof import('@momonga/verify');

const bundledManifestOf = (verifier: VerifyModule): ReturnType<VerifyModule['parseZ3Manifest']> =>
  verifier.parseZ3Manifest(new TextDecoder().decode(getRawAsset(verifier.Z3_MANIFEST_ASSET)));

const bundledVersionOf = (verifier: VerifyModule): string => `z3 ${bundledManifestOf(verifier).contentHash}`;

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
