import { createRequire } from 'node:module';
import { SOLVER_THREAD_STOP_BOUND_MS } from '@momonga/foundation';
import type { Timing } from '@momonga/foundation';
import type { Z3Api } from './smt.ts';

export type Z3Engine = { api: Z3Api; close(): Promise<void> };

type Z3Module = {
  init: (overrides?: { wasmBinary?: Uint8Array }) => Promise<Z3Api>;
  killThreads: (em: Z3Api['em']) => Promise<void>;
};

export type SolverThreads = {
  readonly PThread: { readonly runningWorkers: readonly unknown[]; readonly unusedWorkers: readonly unknown[]; terminateAllThreads(): void };
  readonly async_cancel?: (reason: Error) => void;
};

export const SOLVER_THREAD_POLL_MS = 100;

const anyThreadLeft = ({ PThread }: SolverThreads): boolean => PThread.runningWorkers.length > 0 || PThread.unusedWorkers.length > 0;

export const stopSolverThreads = async (threads: SolverThreads, timing: Timing): Promise<void> => {
  const deadline = timing.monotonicMs() + SOLVER_THREAD_STOP_BOUND_MS;
  threads.PThread.terminateAllThreads();
  for (;;) {
    await new Promise<void>((resolve) => timing.setTimeout(resolve, SOLVER_THREAD_POLL_MS));
    if (!anyThreadLeft(threads)) break;
    if (timing.monotonicMs() >= deadline) throw new Error(`the solver threads did not stop within ${SOLVER_THREAD_STOP_BOUND_MS} ms`);
    threads.PThread.terminateAllThreads();
  }
  threads.async_cancel?.(new Error('Z3 threads were terminated'));
};

export class Z3LoadError extends Error {
  constructor(entry: string, reason: string) {
    super(`the Z3 solver at ${entry} cannot be used: ${reason}`);
    this.name = 'Z3LoadError';
  }
}

const isZ3Module = (value: unknown): value is Z3Module =>
  typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>)['init'] === 'function' && typeof (value as Record<string, unknown>)['killThreads'] === 'function';

export type Z3Source = { entry: string; wasmBinary?: Uint8Array };

export const openZ3 = async (source: Z3Source, timing: Timing): Promise<Z3Engine> => {
  const { entry, wasmBinary } = source;
  const loaded: unknown = createRequire(entry)(entry);
  if (!isZ3Module(loaded)) throw new Z3LoadError(entry, 'it does not export init and killThreads');
  const api = await loaded.init(wasmBinary === undefined ? {} : { wasmBinary });
  return { api, close: () => stopSolverThreads(api.em, timing) };
};

export const resolveInstalledZ3 = (from: string): string => createRequire(from).resolve('z3-solver');
