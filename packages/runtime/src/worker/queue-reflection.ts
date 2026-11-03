import { isFatalStoreError } from '@momonga/store';
import { enqueueReflection } from '../memory/verified-run.ts';
import type { ClaimContext } from './claim-context.ts';
import { reportError } from './report.ts';

export const queueReflection = async (ctx: ClaimContext): Promise<void> => {
  const { options, run } = ctx;
  try {
    await enqueueReflection({ store: options.store, settings: options.settings }, run.id);
  } catch (error) {
    if (isFatalStoreError(error)) throw error;
    reportError(options, error, { runId: run.id, workerId: options.workerId });
  }
};
