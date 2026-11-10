import type { KernelLockMechanism } from './platform/kernel-lock.ts';
import type { MomongaPaths } from './momonga-paths.ts';

export type GenerationReaperOptions = {
  paths: MomongaPaths;
  lock: KernelLockMechanism;
  signal: AbortSignal;
  warn(message: string): void;
};

export type GenerationReaperResult = { removed: readonly number[]; kept: readonly number[] };

export const reapDeadGenerations = async (_options: GenerationReaperOptions): Promise<GenerationReaperResult> => {
  throw new Error('not built');
};
