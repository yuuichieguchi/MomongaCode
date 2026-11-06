import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { isSea } from 'node:sea';
import { nodeEvalFiles } from '@momonga/eval';
import { LIFELINE_FD, createExecWithStdin, createBrowserOpener, createPlatformSecretStore, systemClock } from '@momonga/foundation';
import type { BrowserRunPort } from '@momonga/foundation';
import type { CliClock, CliFiles, CliPorts, SelfExecutable, SpawnDetached } from './ports.ts';

const runBrowser: BrowserRunPort = (file, args, signal) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { signal, windowsHide: true }, (error) => {
      if (error === null) resolve({ exitCode: 0 });
      else if (typeof error.code === 'number') resolve({ exitCode: error.code });
      else reject(error);
    });
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
  readBytes: (file) => fs.readFile(file),
  ensureDirectory: async (directory) => void (await fs.mkdir(directory, { recursive: true })),
  makeTempDirectory: (prefix, base) => fs.mkdtemp(path.join(base ?? os.tmpdir(), prefix)),
  removeTree: (directory) => fs.rm(directory, { recursive: true, force: true }),
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
  rename: (from, to) => fs.rename(from, to),
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
  openUrl: createBrowserOpener({ env: process.env, print: (text) => process.stderr.write(`${text}\n`), run: runBrowser }),
  secretStore: () => createPlatformSecretStore(createExecWithStdin(undefined), process.env),
  acpStdio: () => ({ input: Readable.toWeb(process.stdin), output: Writable.toWeb(process.stdout) }),
});
