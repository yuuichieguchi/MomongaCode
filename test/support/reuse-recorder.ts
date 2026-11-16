import childProcess from 'node:child_process';
import fs from 'node:fs';
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import workerThreads from 'node:worker_threads';
import { afterAll } from 'vitest';
import { observedFileOf, testReuseModeOf } from './reuse-observed.ts';

type Holder = Record<string | symbol, unknown>;
type Call = (...args: unknown[]) => unknown;

type WorkerState = { readonly filepath?: string; readonly moduleExecutionInfo?: ReadonlyMap<string, unknown>; readonly config: { readonly root: string } };

const RECORDING = Symbol.for('momonga.reuseRecorder');

const pathOf = (value: unknown): string | undefined => {
  if (typeof value === 'string') return path.resolve(value);
  if (value instanceof URL) return value.protocol === 'file:' ? fileURLToPath(value) : undefined;
  if (Buffer.isBuffer(value)) return path.resolve(value.toString('utf8'));
  return undefined;
};

const workerState = (): WorkerState => {
  const state = (globalThis as { __vitest_worker__?: WorkerState }).__vitest_worker__;
  if (state === undefined) throw new Error('the reuse recorder runs inside a vitest worker, and none is set up');
  return state;
};

const keepingProperties = (replacement: Call, original: Call): void => {
  for (const key of Reflect.ownKeys(original)) {
    if (key === 'length' || key === 'name' || key === 'prototype' || key === promisify.custom) continue;
    const descriptor = Object.getOwnPropertyDescriptor(original, key);
    if (descriptor !== undefined) Object.defineProperty(replacement, key, descriptor);
  }
  Object.defineProperty(replacement, RECORDING, { value: true });
};

const start = (): void => {
  const reads = new Set<string>();
  let startsProcesses = false;

  const reading = (holder: Holder, name: string | symbol, arguments_: number): void => {
    const original = holder[name] as (Call & { [RECORDING]?: true }) | undefined;
    if (original === undefined || original[RECORDING] === true) return;
    const replacement = function recordingRead(this: unknown, ...args: unknown[]): unknown {
      for (const arg of args.slice(0, arguments_)) {
        const file = pathOf(arg);
        if (file !== undefined) reads.add(file);
      }
      return original.apply(this, args);
    };
    keepingProperties(replacement, original);
    const promised = (original as unknown as Holder)[promisify.custom] as Call | undefined;
    if (promised !== undefined) {
      Object.defineProperty(replacement, promisify.custom, {
        value: function recordingPromisedRead(this: unknown, ...args: unknown[]): unknown {
          for (const arg of args.slice(0, arguments_)) {
            const file = pathOf(arg);
            if (file !== undefined) reads.add(file);
          }
          return promised.apply(this, args);
        },
      });
    }
    Object.defineProperty(holder, name, { value: replacement, writable: true, configurable: true, enumerable: Object.getOwnPropertyDescriptor(holder, name)?.enumerable === true });
  };

  const FILE_READS = ['readFileSync', 'readFile', 'openSync', 'open', 'readdirSync', 'readdir', 'statSync', 'stat', 'lstatSync', 'lstat', 'existsSync', 'exists', 'accessSync', 'access', 'createReadStream', 'realpathSync', 'realpath', 'opendirSync', 'opendir', 'readlinkSync', 'readlink', 'globSync', 'glob'];
  const PROMISED_READS = ['readFile', 'open', 'readdir', 'stat', 'lstat', 'access', 'realpath', 'opendir', 'readlink', 'glob'];
  for (const name of FILE_READS) reading(fs as unknown as Holder, name, 1);
  for (const name of PROMISED_READS) reading(fs.promises as unknown as Holder, name, 1);
  reading(fs.realpathSync as unknown as Holder, 'native', 1);
  reading(fs.realpath as unknown as Holder, 'native', 1);
  reading(fs as unknown as Holder, 'copyFileSync', 1);
  reading(fs as unknown as Holder, 'cpSync', 1);
  reading(fs.promises as unknown as Holder, 'copyFile', 1);
  reading(fs.promises as unknown as Holder, 'cp', 1);

  const launching = (holder: Holder, name: string): void => {
    const original = holder[name] as (Call & { [RECORDING]?: true }) | undefined;
    if (original === undefined || original[RECORDING] === true) return;
    const replacement = function recordingLaunch(this: unknown, ...args: unknown[]): unknown {
      startsProcesses = true;
      return original.apply(this, args);
    };
    keepingProperties(replacement, original);
    holder[name] = replacement;
  };
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) launching(childProcess as unknown as Holder, name);

  const OriginalWorker = workerThreads.Worker;
  class RecordingWorker extends OriginalWorker {
    constructor(...args: ConstructorParameters<typeof OriginalWorker>) {
      startsProcesses = true;
      super(...args);
    }
  }
  (workerThreads as unknown as Holder)['Worker'] = RecordingWorker;
  syncBuiltinESMExports();

  registerHooks({
    load: (url, context, nextLoad) => {
      if (url.startsWith('file:')) reads.add(fileURLToPath(url));
      return nextLoad(url, context);
    },
  });

  const loadedByRequire = (): string[] => Object.keys(createRequire(import.meta.url).cache);

  afterAll(() => {
    const state = workerState();
    if (state.filepath === undefined) throw new Error('the reuse recorder found no test file in the vitest worker');
    if (state.moduleExecutionInfo === undefined) throw new Error('the reuse recorder found no record of the modules the vitest worker ran');
    const observed = observedFileOf(state.config.root, state.filepath, process.pid);
    fs.mkdirSync(path.dirname(observed), { recursive: true, mode: 0o700 });
    fs.writeFileSync(observed, JSON.stringify({ file: state.filepath, reads: [...reads, ...loadedByRequire(), ...state.moduleExecutionInfo.keys()], whole: startsProcesses }), { mode: 0o600 });
  });
};

if (testReuseModeOf(process.env) === 'on') start();
