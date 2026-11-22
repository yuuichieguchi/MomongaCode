import os from 'node:os';

export type PackagingFileStack = {
  readonly peakBytes: number;
  readonly processors: number;
  readonly runProcessors: number;
  readonly memoryShare: number;
};

const MIB = 1024 * 1024;

export const PACKAGING_FILE_STACK: PackagingFileStack = {
  peakBytes: 1024 * MIB,
  processors: 2,
  runProcessors: 1,
  memoryShare: 0.5,
};

export type PackagingHost = { readonly processors: number; readonly memoryBytes: number };

export const packagingFileWorkers = ({ processors, memoryBytes }: PackagingHost, stack: PackagingFileStack = PACKAGING_FILE_STACK): number => {
  const byProcessors = Math.floor((processors - stack.runProcessors) / stack.processors);
  const byMemory = Math.floor((memoryBytes * stack.memoryShare) / stack.peakBytes);
  return Math.max(1, Math.min(byProcessors, byMemory));
};

export const hostPackagingFileWorkers = (): number => packagingFileWorkers({ processors: os.availableParallelism(), memoryBytes: os.totalmem() });
