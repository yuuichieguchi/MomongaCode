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
  const cancel = (): 'done' => {
    journal.snapshot();
    const result = store.transition(claim, ['CANCELLING'], 'CANCELLED');
    if (result.kind === 'lease_lost') control.lost();
    if (result.kind === 'conflict') throw new Error(`run ${claim.runId} could not be cancelled: ${result.reason ?? 'conflict'}`);
    return 'done';
  };

  const yieldLease = (): 'done' => {
    const result = store.releaseLease(claim, { availableAt: clock.now(), refundAttempt: true });
    if (result.kind === 'conflict') throw new Error(`run ${claim.runId} could not release its lease: ${result.reason ?? 'conflict'}`);
    return 'done';
  };

  const settle = (result: RunMutationResult, whenCancelling: () => 'done'): 'done' => {
    if (result.kind === 'lease_lost') control.lost();
    if (result.kind === 'conflict') {
      if (store.getRun(claim.runId)?.status === 'CANCELLING') return whenCancelling();
      throw new Error(`run ${claim.runId} could not change status: ${result.reason ?? 'conflict'}`);
    }
    return 'done';
  };

  return {
    finish: (to, patch, preceding = []) => {
      journal.snapshot();
      return settle(store.transition(claim, ['RUNNING'], to, patch, preceding), () => {
        if (preceding.length > 0) journal.append(preceding);
        return cancel();
      });
    },
    yieldTo: (to, availableAt, options) => {
      journal.snapshot();
      return settle(store.release(claim, to, availableAt, options), yieldLease);
    },
    cancel,
    yieldLease,
  };
};
