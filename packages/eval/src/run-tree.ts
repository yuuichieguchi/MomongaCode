import { canonicalJson } from '@momonga/foundation';
import { nanoOfUnits } from '@momonga/protocol';
import type { RunCostView } from '@momonga/protocol';

export const answeredByOfRuns = async <Answerer>(answeredBy: (runId: string) => Promise<readonly Answerer[]>, runIds: readonly string[]): Promise<Answerer[]> => {
  const unique = new Map<string, Answerer>();
  for (const runId of runIds) {
    for (const answerer of await answeredBy(runId)) unique.set(canonicalJson(answerer), answerer);
  }
  return [...unique.values()];
};

export type TreeSpend = { tokensTotal: number; costNano: number };

export const treeSpendOf = (runs: readonly TreeSpend[]): TreeSpend => ({
  tokensTotal: runs.reduce((total, run) => total + run.tokensTotal, 0),
  costNano: runs.reduce((total, run) => total + run.costNano, 0),
});

export const nanoOfCostViews = (costs: readonly RunCostView[]): number =>
  nanoOfUnits(costs.reduce((total, cost) => cost.priced.reduce((sum, amount) => sum + BigInt(amount.units), total), 0n).toString());
