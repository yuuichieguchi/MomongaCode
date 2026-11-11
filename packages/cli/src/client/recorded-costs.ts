import { REPORT_PAGE_ROWS } from '@momonga/protocol';
import type { RunCostView } from '@momonga/protocol';
import type { RuntimeClient } from './runtime-client.ts';

export const recordedCostsOf = async (client: Pick<RuntimeClient, 'reportCost'>, runIds: readonly string[]): Promise<RunCostView[]> => {
  const costs: RunCostView[] = [];
  for (let start = 0; start < runIds.length; start += REPORT_PAGE_ROWS) costs.push(...(await client.reportCost(runIds.slice(start, start + REPORT_PAGE_ROWS))));
  return costs;
};
