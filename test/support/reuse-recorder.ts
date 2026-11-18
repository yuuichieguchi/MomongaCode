import childProcess from 'node:child_process';
import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import workerThreads from 'node:worker_threads';
import { afterAll } from 'vitest';
import { RECORDING, keepingProperties, recordReads } from './read-recorder.ts';
import type { Call, Holder } from './read-recorder.ts';
import { observedFileOf, testReuseModeOf } from './reuse-observed.ts';

type WorkerState = { readonly filepath?: string; readonly moduleExecutionInfo?: ReadonlyMap<string, unknown>; readonly config: { readonly root: string } };

const workerState = (): WorkerState => {
  const state = (globalThis as { __vitest_worker__?: WorkerState }).__vitest_worker__;
  if (state === undefined) throw new Error('the reuse recorder runs inside a vitest worker, and none is set up');
  return state;
};

export const recordingLaunchOf = (original: Call, onStart: () => void): Call => {
  const replacement = function recordingLaunch(this: unknown, ...args: unknown[]): unknown {
    onStart();
    return original.apply(this, args);
  };
  keepingProperties(replacement, original);
  const promised = (original as unknown as Holder)[promisify.custom] as Call | undefined;
  if (promised !== undefined) Object.defineProperty(replacement, promisify.custom, { value: recordingLaunchOf(promised, onStart) });
  return replacement;
};

const start = (): void => {
  const reads = new Set<string>();
  let startsProcesses = false;
  recordReads((file) => reads.add(file));

  const launching = (holder: Holder, name: string): void => {
    const original = holder[name] as (Call & { [RECORDING]?: true }) | undefined;
    if (original === undefined || original[RECORDING] === true) return;
    holder[name] = recordingLaunchOf(original, () => {
      startsProcesses = true;
    });
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
