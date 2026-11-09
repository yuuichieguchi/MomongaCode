import { SANDBOX_KILL_GRACE_MS, launch } from './process.ts';
import type { Sandbox, SandboxCommand, SandboxDescriptors, SandboxedProcess } from './types.ts';

export function createUnsandboxed(options: { killGraceMs?: number } = {}): Sandbox {
  return {
    kind: 'none',
    spawn(command: SandboxCommand, _policy, signal: AbortSignal, descriptors?: SandboxDescriptors): SandboxedProcess {
      const [file, ...args] = command.argv;
      if (file === undefined) throw new Error('argv must not be empty');
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
      });
    },
  };
}
