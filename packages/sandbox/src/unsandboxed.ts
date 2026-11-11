import type { ChildProtection } from '@momonga/foundation';
import { DEFAULT_BWRAP_PATH } from './bubblewrap.ts';
import { SANDBOX_KILL_GRACE_MS, launch } from './process.ts';
import { protectionCommandOf } from './protection.ts';
import { DEFAULT_SANDBOX_EXEC_PATH } from './seatbelt.ts';
import type { Sandbox, SandboxCommand, SandboxDescriptors, SandboxedProcess } from './types.ts';

export type UnsandboxedOptions = {
  killGraceMs?: number;
  protection: ChildProtection;
  platform: NodeJS.Platform;
  sandboxExecPath?: string;
  bwrapPath?: string;
};

export type ProtectionOnlySandbox = Sandbox & { readonly protection: ChildProtection };

export function createUnsandboxed(options: UnsandboxedOptions): ProtectionOnlySandbox {
  const { protection } = options;
  return {
    kind: 'none',
    protection,
    spawn(command: SandboxCommand, _policy, signal: AbortSignal, descriptors?: SandboxDescriptors): SandboxedProcess {
      const { file, args } = protectionCommandOf(protection, {
        platform: options.platform,
        argv: command.argv,
        scratch: command.tmpDir === undefined ? [] : [command.tmpDir],
        sandboxExecPath: options.sandboxExecPath ?? DEFAULT_SANDBOX_EXEC_PATH,
        bwrapPath: options.bwrapPath ?? DEFAULT_BWRAP_PATH,
      });
      return launch({
        file,
        args,
        cwd: command.cwd,
        ...(command.markerFile === undefined ? {} : { markerFile: command.markerFile }),
        ...(descriptors?.markerFd === undefined ? {} : { markerFd: descriptors.markerFd }),
        ...(command.stdin === undefined ? {} : { stdin: command.stdin }),
        env: command.tmpDir === undefined ? command.env : { ...command.env, TMPDIR: command.tmpDir },
        signal,
        killGraceMs: options.killGraceMs ?? SANDBOX_KILL_GRACE_MS,
        afterExit: () => undefined,
        protection,
      });
    },
  };
}
