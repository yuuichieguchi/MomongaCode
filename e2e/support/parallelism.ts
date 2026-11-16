import os from 'node:os';

export type E2eFileStack = {
  readonly peakBytes: number;
  readonly processors: number;
  readonly runProcessors: number;
  readonly memoryShare: number;
};

const MIB = 1024 * 1024;

export const E2E_FILE_STACK: E2eFileStack = {
  peakBytes: 1031 * MIB,
  processors: 1,
  runProcessors: 1,
  memoryShare: 0.5,
};

export const E2E_FILE_STACK_RATIONALE = [
  'peakBytes: the resident memory of one e2e file and its stack (the vitest worker 277 MiB, the supervisor 180 MiB, the gateway 297 MiB, the runtime 277 MiB), measured with ps -A -E -o rss while e2e/b2-bash.test.ts ran alone on 2026-11-16 at 53499d973',
  'processors: the busiest moment of one stack is its start, when the three daemons spent 3.3 s of processor time in about 4 s of wall time (ps -o time, same run); one processor per stack keeps a starting stack from waiting on another',
  'runProcessors: the vitest main process and the esbuild service, which every file shares, keep one processor',
  'memoryShare: the e2e files take at most half of the memory of the machine, the rest is the system and the person',
] as const;

export type E2eHost = { readonly processors: number; readonly memoryBytes: number };

export const e2eFileWorkers = ({ processors, memoryBytes }: E2eHost, stack: E2eFileStack = E2E_FILE_STACK): number => {
  const byProcessors = Math.floor((processors - stack.runProcessors) / stack.processors);
  const byMemory = Math.floor((memoryBytes * stack.memoryShare) / stack.peakBytes);
  return Math.max(1, Math.min(byProcessors, byMemory));
};

export const hostE2eFileWorkers = (): number => e2eFileWorkers({ processors: os.availableParallelism(), memoryBytes: os.totalmem() });
