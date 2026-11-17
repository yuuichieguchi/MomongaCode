import os from 'node:os';

export type TlcHost = { readonly processors: number; readonly memoryBytes: number };

export type TlcRowStack = { readonly memoryShare: number; readonly heapShare: number };

export const TLC_ROW_STACK: TlcRowStack = {
  memoryShare: 0.5,
  heapShare: 0.25,
};

export const tlcWorkersOf = (processors: number): number => Math.ceil(processors / 2);

const jvmHeapCeilingOf = (memoryBytes: number, stack: TlcRowStack = TLC_ROW_STACK): number => memoryBytes * stack.heapShare;

export const tlcRowsAtOnce = (host: TlcHost, stack: TlcRowStack = TLC_ROW_STACK): number => {
  const byProcessors = Math.floor(host.processors / tlcWorkersOf(host.processors));
  const byMemory = Math.floor((host.memoryBytes * stack.memoryShare) / jvmHeapCeilingOf(host.memoryBytes, stack));
  return Math.max(1, Math.min(byProcessors, byMemory));
};

export const hostTlcRowsAtOnce = (): number => tlcRowsAtOnce({ processors: os.availableParallelism(), memoryBytes: os.totalmem() });
