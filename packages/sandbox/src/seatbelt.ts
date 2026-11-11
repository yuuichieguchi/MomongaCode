import fs from 'node:fs';
import { launch } from './process.ts';
import { buildSeatbeltProfile, paramArgsOf } from './profile.ts';
import { createOwnedDirectorySync, hostPaths, nodeFileSystem, settledOrAborted } from '@momonga/foundation';
import { assertExistingDirectory } from './scratch.ts';
import type { Sandbox, SandboxCommand, SandboxDescriptors, SandboxPolicy, SandboxedProcess } from './types.ts';
import type { KernelLockMechanism } from '@momonga/foundation';

export const DEFAULT_SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';

const SEATBELT_LAUNCH = { kind: 'sandboxed', backend: 'seatbelt' } as const;

export interface SeatbeltSandboxOptions {
  sandboxExecPath?: string;
  tmpRoot: string;
  lock: KernelLockMechanism;
  killGraceMs: number;
}

export function createSeatbeltSandbox(options: SeatbeltSandboxOptions): Sandbox {
  const sandboxExecPath = options.sandboxExecPath ?? DEFAULT_SANDBOX_EXEC_PATH;
  fs.accessSync(sandboxExecPath, fs.constants.X_OK);

  return {
    kind: 'seatbelt',
    async spawn(command: SandboxCommand, policy: SandboxPolicy, signal: AbortSignal, descriptors?: SandboxDescriptors): Promise<SandboxedProcess> {
      const paths = hostPaths(signal);
      for (const root of policy.writableRoots) await assertExistingDirectory(root);
      if (command.tmpDir !== undefined) {
        await assertExistingDirectory(command.tmpDir);
        const { profile, params } = await buildSeatbeltProfile(policy, { tmpDir: command.tmpDir }, paths);
        return launch({
          file: sandboxExecPath,
          args: ['-p', profile, ...paramArgsOf(params), '--', ...command.argv],
          cwd: command.cwd,
          ...(command.markerFile === undefined ? {} : { markerFile: command.markerFile }),
          ...(descriptors?.markerFd === undefined ? {} : { markerFd: descriptors.markerFd }),
          ...(command.stdin === undefined ? {} : { stdin: command.stdin }),
          env: { ...command.env, TMPDIR: command.tmpDir },
          signal,
          killGraceMs: options.killGraceMs,
          afterExit: () => undefined,
          protection: SEATBELT_LAUNCH,
        });
      }
      const tmpRoot = await settledOrAborted(nodeFileSystem.realpath(options.tmpRoot), signal);
      const scratch = createOwnedDirectorySync({ parent: tmpRoot, prefix: 'sandbox-', lock: options.lock });
      const tmpDir = scratch.path;
      try {
        const scratchDir = await paths.canonicalPath(tmpDir);
        const { profile, params } = await buildSeatbeltProfile({ ...policy, writableRoots: [...policy.writableRoots, scratchDir] }, { scratchDir }, paths);
        return launch({
          file: sandboxExecPath,
          args: ['-p', profile, ...paramArgsOf(params), '--', ...command.argv],
          cwd: command.cwd,
          ...(command.markerFile === undefined ? {} : { markerFile: command.markerFile }),
          ...(descriptors?.markerFd === undefined ? {} : { markerFd: descriptors.markerFd }),
          ...(command.stdin === undefined ? {} : { stdin: command.stdin }),
          env: { ...command.env, TMPDIR: tmpDir },
          signal,
          killGraceMs: options.killGraceMs,
          afterExit: () => scratch.dispose(),
          protection: SEATBELT_LAUNCH,
        });
      } catch (error) {
        scratch.dispose();
        throw error;
      }
    },
  };
}
