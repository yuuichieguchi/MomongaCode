import os from 'node:os';
import type { Tier } from './manifest-reader.ts';

const MIB = 1024 * 1024;

export type TlcHost = { readonly processors: number; readonly memoryBytes: number };

export type TlcRowStack = { readonly memoryShare: number; readonly heapShare: number };

export type EveryRunTlcRowStack = {
  readonly workers: number;
  readonly heapBytes: number;
  readonly runProcessors: number;
  readonly memoryShare: number;
};

export const TLC_ROW_STACK: TlcRowStack = {
  memoryShare: 0.5,
  heapShare: 0.25,
};

export const EVERY_RUN_TLC_WORKERS = 1;
export const EVERY_RUN_TLC_MAX_HEAP_MIB = 1024;

export const EVERY_RUN_TLC_ROW_STACK: EveryRunTlcRowStack = {
  workers: EVERY_RUN_TLC_WORKERS,
  heapBytes: EVERY_RUN_TLC_MAX_HEAP_MIB * MIB,
  runProcessors: 1,
  memoryShare: 0.5,
};

export const tlcWorkersOf = (processors: number): number => Math.ceil(processors / 2);

export const tlcWorkersForTier = (tier: Tier, processors: number = os.availableParallelism()): number =>
  tier === 'every-run' ? EVERY_RUN_TLC_WORKERS : tlcWorkersOf(processors);

const jvmHeapCeilingOf = (memoryBytes: number, stack: TlcRowStack = TLC_ROW_STACK): number => memoryBytes * stack.heapShare;

export const tlcRowsAtOnce = (host: TlcHost, stack: TlcRowStack = TLC_ROW_STACK): number => {
  const byProcessors = Math.floor(host.processors / tlcWorkersOf(host.processors));
  const byMemory = Math.floor((host.memoryBytes * stack.memoryShare) / jvmHeapCeilingOf(host.memoryBytes, stack));
  return Math.max(1, Math.min(byProcessors, byMemory));
};

export const everyRunTlcRowsAtOnce = (host: TlcHost, stack: EveryRunTlcRowStack = EVERY_RUN_TLC_ROW_STACK): number => {
  const byProcessors = Math.floor((host.processors - stack.runProcessors) / stack.workers);
  const byMemory = Math.floor((host.memoryBytes * stack.memoryShare) / stack.heapBytes);
  return Math.max(1, Math.min(byProcessors, byMemory));
};

export const hostTlcRowsAtOnce = (): number => tlcRowsAtOnce({ processors: os.availableParallelism(), memoryBytes: os.totalmem() });

export const hostEveryRunTlcRowsAtOnce = (): number => everyRunTlcRowsAtOnce({ processors: os.availableParallelism(), memoryBytes: os.totalmem() });

export const hostTlcRowsForTier = (tier: Tier): number => (tier === 'every-run' ? hostEveryRunTlcRowsAtOnce() : hostTlcRowsAtOnce());
