import { admitRequest } from '@momonga/protocol';
import type { BudgetAccount } from '../../src/worker/admitted-request.ts';

const NOTHING_SPENT = { totalTokens: 0, costNano: 0, unpricedCalls: 0, reservedTokens: 0, reservedNano: 0 };

export const unlimitedBudget = (): BudgetAccount => ({
  limits: { maxTotalTokens: Number.MAX_SAFE_INTEGER },
  quote: async (model) => ({ model, priced: false }),
  spend: () => NOTHING_SPENT,
  ledger: { admitModelRequest: (ask) => admitRequest(ask, NOTHING_SPENT) },
  tail: Promise.resolve(),
});
