import type { Claim, RunMutationResult, RuntimeStore } from '@momonga/store';
import type { Terminals } from './claim-context.ts';
import type { ClaimControl } from './claim-control.ts';
import type { Journal } from './journal.ts';

export type TerminalsOptions = {
  store: RuntimeStore;
  claim: Claim;
  journal: Journal;
  control: ClaimControl;
};

export const createTerminals = ({ store, claim, journal, control }: TerminalsOptions): Terminals => {
  const cancel = (): 'done' => {
    journal.snapshot();
    const result = store.transition(claim, ['CANCELLING'], 'CANCELLED');
    if (result.kind === 'lease_lost') control.lost();
    if (result.kind === 'conflict') throw new Error(`run ${claim.runId} could not be cancelled: ${result.reason ?? 'conflict'}`);
    return 'done';
  };

  const settle = (result: RunMutationResult): 'done' => {
    if (result.kind === 'lease_lost') control.lost();
    if (result.kind === 'conflict') {
      if (store.getRun(claim.runId)?.status === 'CANCELLING') return cancel();
      throw new Error(`run ${claim.runId} could not change status: ${result.reason ?? 'conflict'}`);
    }
    return 'done';
  };

  return {
    finish: (to, patch) => {
      journal.snapshot();
      return settle(store.transition(claim, ['RUNNING'], to, patch));
    },
    yieldTo: (to, availableAt) => {
      journal.snapshot();
      return settle(store.release(claim, to, availableAt));
    },
    cancel,
  };
};
