import { spawn } from 'node:child_process';
import os from 'node:os';
import { EXIT_SIGNAL_BASE } from '@momonga/foundation';
import { flushOutput } from '../flush-output.ts';

export type ReplaceTarget = { file: string; args: readonly string[]; env: NodeJS.ProcessEnv };

export const RELAYED_SIGNALS = ['SIGTERM', 'SIGHUP'] as const;

export type RelayedSignal = (typeof RELAYED_SIGNALS)[number];

export type RelayChild = {
  readonly pid?: number | undefined;
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
};

export type ReplaceHost = {
  execve: ((file: string, args: readonly string[], env: NodeJS.ProcessEnv) => void) | undefined;
  spawn(file: string, args: readonly string[], options: { stdio: 'inherit'; env: NodeJS.ProcessEnv }): RelayChild;
  exit(code: number): void;
  flush(): Promise<void>;
  onSignal(signal: RelayedSignal, listener: () => void): void;
};

export type ReplaceHooks = { release(): void; relayed(childPid: number): void };

const exitCodeOf = (code: number | null, signal: NodeJS.Signals | null): number => code ?? EXIT_SIGNAL_BASE + (signal === null ? 0 : os.constants.signals[signal]);

const relay = (target: ReplaceTarget, host: ReplaceHost, hooks: ReplaceHooks): Promise<'relayed'> =>
  new Promise((resolve, reject) => {
    hooks.release();
    const child = host.spawn(target.file, target.args, { stdio: 'inherit', env: target.env });
    child.once('error', reject);
    child.once('spawn', () => {
      for (const signal of RELAYED_SIGNALS) host.onSignal(signal, () => void child.kill(signal));
      try {
        if (child.pid === undefined) throw new Error(`the relayed ${target.file} started without a pid`);
        hooks.relayed(child.pid);
      } catch (error) {
        child.kill('SIGTERM');
        reject(error);
      }
    });
    child.once('exit', (code, signal) => {
      host.flush().then(() => {
        host.exit(exitCodeOf(code, signal));
        resolve('relayed');
      }, reject);
    });
  });

export const replaceProcess = async (target: ReplaceTarget, host: ReplaceHost, hooks: ReplaceHooks): Promise<'relayed'> => {
  if (typeof host.execve !== 'function') return relay(target, host, hooks);
  await host.flush();
  host.execve(target.file, [target.file, ...target.args], target.env);
  throw new Error(`the exec of ${target.file} returned without replacing the process`);
};

export const hostReplace: ReplaceHost = {
  execve: typeof process.execve === 'function' ? (file, args, env) => process.execve?.(file, args, env) : undefined,
  spawn: (file, args, options) => spawn(file, args, options),
  exit: (code) => process.exit(code),
  flush: () => flushOutput([process.stdout, process.stderr]),
  onSignal: (signal, listener) => {
    process.on(signal, listener);
  },
};
