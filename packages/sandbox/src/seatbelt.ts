import fs from 'node:fs';
import path from 'node:path';
import { canonicalizePath } from './canonical-path.ts';
import { launch } from './process.ts';
import { buildSeatbeltProfile } from './profile.ts';
import type { Sandbox, SandboxCommand, SandboxPolicy, SandboxedProcess } from './types.ts';

const DEFAULT_SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';

export interface SeatbeltSandboxOptions {
  sandboxExecPath?: string;
  tmpRoot: string;
  killGraceMs: number;
}

function assertExistingDirectory(root: string): void {
  if (!path.isAbsolute(root)) throw new Error(`writable root must be absolute: ${root}`);
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`writable root does not exist or is not a directory: ${root}`);
  }
}

function removePrivateTmpDir(dir: string): void {
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (stat === undefined) return;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fs.unlinkSync(dir);
    return;
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

export function createSeatbeltSandbox(options: SeatbeltSandboxOptions): Sandbox {
  const sandboxExecPath = options.sandboxExecPath ?? DEFAULT_SANDBOX_EXEC_PATH;
  fs.accessSync(sandboxExecPath, fs.constants.X_OK);
  const tmpRoot = fs.realpathSync(options.tmpRoot);

  return {
    kind: 'seatbelt',
    spawn(command: SandboxCommand, policy: SandboxPolicy, signal: AbortSignal): SandboxedProcess {
      for (const root of policy.writableRoots) assertExistingDirectory(root);
      const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'sandbox-'));
      try {
        const { profile, params } = buildSeatbeltProfile({
          ...policy,
          writableRoots: [...policy.writableRoots, canonicalizePath(tmpDir)],
        });
        const paramArgs = Object.entries(params).flatMap(([name, value]) => ['-D', `${name}=${value}`]);
        return launch({
          file: sandboxExecPath,
          args: ['-p', profile, ...paramArgs, '--', ...command.argv],
          cwd: command.cwd,
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
