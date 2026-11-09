import fs from 'node:fs';
import path from 'node:path';
import { canonicalizePath } from './canonical-path.ts';
import { launch } from './process.ts';
import { buildSeatbeltProfile } from './profile.ts';
import { assertExistingDirectory, removePrivateTmpDir } from './scratch.ts';
import type { Sandbox, SandboxCommand, SandboxDescriptors, SandboxPolicy, SandboxedProcess } from './types.ts';

const DEFAULT_SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';

export interface SeatbeltSandboxOptions {
  sandboxExecPath?: string;
  tmpRoot: string;
  killGraceMs: number;
}

const paramArgsOf = (params: Record<string, string>): string[] => Object.entries(params).flatMap(([name, value]) => ['-D', `${name}=${value}`]);

export function createSeatbeltSandbox(options: SeatbeltSandboxOptions): Sandbox {
  const sandboxExecPath = options.sandboxExecPath ?? DEFAULT_SANDBOX_EXEC_PATH;
  fs.accessSync(sandboxExecPath, fs.constants.X_OK);
  const tmpRoot = fs.realpathSync(options.tmpRoot);

  return {
    kind: 'seatbelt',
    spawn(command: SandboxCommand, policy: SandboxPolicy, signal: AbortSignal, descriptors?: SandboxDescriptors): SandboxedProcess {
      for (const root of policy.writableRoots) assertExistingDirectory(root);
      if (command.tmpDir !== undefined) {
        assertExistingDirectory(command.tmpDir);
        const { profile, params } = buildSeatbeltProfile(policy, { tmpDir: command.tmpDir });
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
        });
      }
      const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'sandbox-'));
      try {
        const scratchDir = canonicalizePath(tmpDir);
        const { profile, params } = buildSeatbeltProfile({ ...policy, writableRoots: [...policy.writableRoots, scratchDir] }, { scratchDir });
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
          afterExit: () => removePrivateTmpDir(tmpDir),
        });
      } catch (error) {
        removePrivateTmpDir(tmpDir);
        throw error;
      }
    },
  };
}
