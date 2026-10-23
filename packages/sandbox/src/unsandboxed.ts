import { launch } from './process.ts';
import type { Sandbox, SandboxCommand, SandboxedProcess } from './types.ts';

const DEFAULT_KILL_GRACE_MS = 2000;

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
        env: command.env,
        signal,
        killGraceMs: options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
        afterExit: () => undefined,
      });
    },
  };
}
