import { SANDBOX_KILL_GRACE_MS, launch } from './process.ts';
import type { Sandbox, SandboxCommand, SandboxedProcess } from './types.ts';

export function createUnsandboxed(options: { killGraceMs?: number } = {}): Sandbox {
  return {
    kind: 'none',
    spawn(command: SandboxCommand, _policy, signal: AbortSignal): SandboxedProcess {
      const [file, ...args] = command.argv;
      if (file === undefined) throw new Error('argv must not be empty');
      return launch({
        file,
        args,
        cwd: command.cwd,
        ...(command.markerFile === undefined ? {} : { markerFile: command.markerFile }),
        ...(command.stdin === undefined ? {} : { stdin: command.stdin }),
        env: command.tmpDir === undefined ? command.env : { ...command.env, TMPDIR: command.tmpDir },
        signal,
        killGraceMs: options.killGraceMs ?? SANDBOX_KILL_GRACE_MS,
        afterExit: () => undefined,
      });
    },
  };
}
