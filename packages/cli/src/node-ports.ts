import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { isSea } from 'node:sea';
import { nodeEvalFiles } from '@momonga/eval';
import { LIFELINE_FD, createBrowserOpener, createExecWithStdin, createHostExec, createPlatformSecretStore, minimalChildEnv, nodeFileSystem, systemClock, systemRandom, writeFileAtomically } from '@momonga/foundation';
import type { LaunchProgram } from '@momonga/foundation';
import type { CliClock, CliFiles, CliPorts, SelfExecutable, SpawnDetached } from './ports.ts';

export const launchProgram: LaunchProgram = (file, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
    child.unref();
  });

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

export const nodeFiles: CliFiles = {
  ...nodeEvalFiles,
  readFile: nodeFileSystem.readFile,
  readTextFile: nodeFileSystem.readTextFile,
  mkdir: nodeFileSystem.mkdir,
  mkdirPrivate: nodeFileSystem.mkdirPrivate,
  mkdtemp: nodeFileSystem.mkdtemp,
  rm: nodeFileSystem.rm,
  rename: nodeFileSystem.rename,
  readTextIfPresent: async (file) => {
    try {
      return await fs.readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  },
  appendText: async (file, text, modes) => {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: modes.directory });
    await fs.appendFile(file, text, { mode: modes.file });
  },
  exists: async (file) => {
    try {
      await nodeFileSystem.stat(file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  },
  writeTextAtomically: async (file, text, mode) => {
    await writeFileAtomically(nodeFileSystem, systemRandom, file, text, { mode });
  },
};

export const nodeSpawnDetached: SpawnDetached = (spec) => {
  const child = spawn(spec.command, [...spec.args], {
    cwd: spec.cwd,
    env: { ...spec.env },
    detached: true,
    stdio: spec.lifeline === true ? ['ignore', 'ignore', 'ignore', 'pipe'] : 'ignore',
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  child.unref();
  const lifeline = spec.lifeline === true ? child.stdio[LIFELINE_FD] : undefined;
  if (lifeline instanceof net.Socket) {
    lifeline.unref();
    lifeline.on('error', () => undefined);
    return { exit, releaseLifeline: () => void lifeline.destroy() };
  }
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
  platform: process.platform,
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
  files: nodeFiles,
  exec: createHostExec(minimalChildEnv(process.env)),
  openUrl: createBrowserOpener({ env: process.env, launch: launchProgram }),
  secretStore: () => createPlatformSecretStore(createExecWithStdin(undefined), process.env),
  acpStdio: () => ({ input: Readable.toWeb(process.stdin), output: Writable.toWeb(process.stdout) }),
});
