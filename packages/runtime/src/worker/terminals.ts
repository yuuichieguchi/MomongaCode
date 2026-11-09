import type { Clock } from '@momonga/foundation';
import type { Claim, RunMutationResult, RuntimeStore } from '@momonga/store';
import type { Terminals } from './claim-context.ts';
import type { ClaimControl } from './claim-control.ts';
import type { Journal } from './journal.ts';

export type TerminalsOptions = {
  store: RuntimeStore;
  claim: Claim;
  journal: Journal;
  control: ClaimControl;
  clock: Clock;
};

export const createTerminals = ({ store, claim, journal, control, clock }: TerminalsOptions): Terminals => {
  const cancel = async (): Promise<'done'> => {
    journal.snapshot();
    const result = await store.transition(claim, ['CANCELLING'], 'CANCELLED');
    if (result.kind === 'lease_lost') control.lost();
    if (result.kind === 'conflict') throw new Error(`run ${claim.runId} could not be cancelled: ${result.reason ?? 'conflict'}`);
    return 'done';
  };

  const yieldLease = async (): Promise<'done'> => {
    const result = await store.releaseLease(claim, { availableAt: clock.now(), refundAttempt: true });
    if (result.kind === 'conflict') throw new Error(`run ${claim.runId} could not release its lease: ${result.reason ?? 'conflict'}`);
    return 'done';
  };

  const settle = (result: RunMutationResult): 'settled' | 'cancelling' => {
    if (result.kind === 'lease_lost') control.lost();
    if (result.kind === 'conflict') {
      if (store.getRun(claim.runId)?.status === 'CANCELLING') return 'cancelling';
      throw new Error(`run ${claim.runId} could not change status: ${result.reason ?? 'conflict'}`);
    }
    return 'settled';
  };

  return {
    finish: async (to, patch, preceding = []) => {
      journal.snapshot();
      if (settle(await store.transition(claim, ['RUNNING'], to, patch, preceding)) === 'cancelling') {
        if (preceding.length > 0) journal.append(preceding);
        return cancel();
      }
      return 'done';
    },
    yieldTo: async (to, availableAt, options) => {
      journal.snapshot();
      return settle(await store.release(claim, to, availableAt, options)) === 'cancelling' ? yieldLease() : 'done';
    },
    cancel,
    yieldLease,
  };
};
