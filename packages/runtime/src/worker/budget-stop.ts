import type { BudgetExhausted } from '@momonga/protocol';
import { AdmissionRefusedError, exhaustedMessage } from './admitted-request.ts';
import type { Refused } from './admitted-request.ts';
import type { ClaimContext, Flow } from './claim-context.ts';

export const stopReasonOf = (exhausted: BudgetExhausted): 'max_steps' | 'budget' => (exhausted.dimension === 'steps' ? 'max_steps' : 'budget');

export const stopExhausted = (ctx: ClaimContext, exhausted: BudgetExhausted): Promise<Flow> => {
  ctx.journal.append([
    { type: 'budget.exhausted', ...exhausted },
    { type: 'notice', level: 'error', message: exhaustedMessage(exhausted), code: 'budget_exhausted' },
  ]);
  return ctx.terminals.finish('STOPPED', { stopReason: stopReasonOf(exhausted) });
};

export const stopRefused = (ctx: ClaimContext, refused: Refused): Promise<Flow> =>
  refused.kind === 'lease_lost' ? ctx.terminals.yieldLease() : stopExhausted(ctx, refused.exhausted);

export const stopIfRefused = async (ctx: ClaimContext, error: unknown): Promise<'done'> => {
  if (!(error instanceof AdmissionRefusedError)) throw error;
  await stopRefused(ctx, error.refused);
  return 'done';
};
