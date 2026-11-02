import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { isSea } from 'node:sea';
import { systemClock } from '@momonga/foundation';
import type { CliClock, CliPorts, SelfExecutable, SpawnDetached } from './ports.ts';

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export const nodeClock: CliClock = { now: () => systemClock.now(), sleep };

export const nodeSpawnDetached: SpawnDetached = (spec) => {
  const child = spawn(spec.command, [...spec.args], { cwd: spec.cwd, env: { ...spec.env }, detached: true, stdio: 'ignore' });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  child.unref();
  return { exit };
};

export const nodeSelf = (argv: readonly string[], singleBinary: () => boolean): SelfExecutable => {
  if (singleBinary()) return { kind: 'single-binary', execPath: process.execPath };
  const script = argv[1];
  if (script === undefined) throw new Error('cannot locate the momonga entry script: process.argv[1] is empty');
  return { kind: 'script', execPath: process.execPath, script: path.resolve(script) };
};

export const nodePorts = (version: string): CliPorts => ({
  version,
  env: process.env,
  cwd: process.cwd(),
  home: process.env['HOME'] ?? os.homedir(),
  stdout: process.stdout,
  stderr: process.stderr,
  clock: nodeClock,
  random: Math.random,
  self: nodeSelf(process.argv, isSea),
  spawnDetached: nodeSpawnDetached,
  terminal: process.stdin.isTTY && process.stdout.isTTY ? { stdin: process.stdin, stdout: process.stdout } : undefined,
});
