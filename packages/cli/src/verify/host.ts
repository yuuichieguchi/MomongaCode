import fs from 'node:fs/promises';
import { getRawAsset, isSea } from 'node:sea';
import { nodeFileSystem } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import type { CliPorts } from '../ports.ts';
import { randomFraction } from '../ripgrep/host.ts';

export type VerifyModule = typeof import('@momonga/verify');
export type VerifyRequestShape = Parameters<VerifyModule['verifyPermissions']>[1];
export type SolverEngine = Awaited<ReturnType<VerifyModule['openZ3']>>;

export type PolicyVerifyHost = {
  loadVerifier(): Promise<VerifyModule>;
  loadPolicyFilesystem(): Promise<VerifyRequestShape['fs']>;
  openSolver(verifier: VerifyModule): Promise<SolverEngine>;
};

export const nodePolicyVerifyHost = (ports: Pick<CliPorts, 'random'>, paths: Pick<MomongaPaths, 'executables'>): PolicyVerifyHost => ({
  loadVerifier: () => import('@momonga/verify'),
  loadPolicyFilesystem: async () => (await import('@momonga/runtime')).createPolicyFilesystem(),
  openSolver: async (verifier) => {
    if (!isSea()) return verifier.openZ3({ entry: verifier.resolveInstalledZ3(import.meta.url) });
    const bundled = await verifier.ensureBundledZ3({
      asset: (name) => new Uint8Array(getRawAsset(name)),
      executablesRoot: paths.executables,
      random: ports.random,
      files: {
        exists: async (target) => {
          try {
            await fs.access(target);
            return true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
            throw error;
          }
        },
        writeBytes: (file, bytes) => fs.writeFile(file, bytes, { mode: 0o600 }),
        readFile: nodeFileSystem.readFile,
        mkdir: nodeFileSystem.mkdir,
        rm: nodeFileSystem.rm,
        rename: nodeFileSystem.rename,
      },
    });
    return verifier.openZ3(bundled);
  },
});

type RuntimeEntry = typeof import('@momonga/runtime/entry');
type RuleSolverSource = NonNullable<Parameters<RuntimeEntry['runRuntimeEntry']>[1]['ruleSolver']>;

export const embeddedRuleSolver = (): RuleSolverSource | undefined => {
  if (!isSea()) return undefined;
  return (paths) => {
    const host = nodePolicyVerifyHost({ random: randomFraction }, paths);
    return {
      loadVerifier: host.loadVerifier,
      openSolver: host.openSolver,
      solverVersion: async () => {
        const verifier = await host.loadVerifier();
        return `z3 ${verifier.parseZ3Manifest(new TextDecoder().decode(getRawAsset(verifier.Z3_MANIFEST_ASSET))).contentHash}`;
      },
    };
  };
};
