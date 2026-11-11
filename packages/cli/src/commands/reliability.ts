import type { MomongaPaths } from '@momonga/foundation';
import { REPORT_PAGE_ROWS } from '@momonga/protocol';
import type { ReportPage, RunCostView } from '@momonga/protocol';
import { aggregate, buildReliabilityReport, costOf, countedRunIdsOf, explainOf, formatReliabilityReport, merge, withinPeriod } from '@momonga/reliability';
import type { Aggregate, GroupKey, Period } from '@momonga/reliability';
import { ensureCurrentDaemon } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import { connectRuntime } from '../run/open-session.ts';

export type ReliabilityOptions = { groupBy: GroupKey; explain: boolean; days: number };

export const DEFAULT_REPORT_DAYS = 30;

const DAY_MS = 86_400_000;

export type FactsPages = { reportFacts(request: { cursor: string | null; limit: number }): Promise<ReportPage> };

export type ReportClient = FactsPages & { reportCost(runIds: readonly string[]): Promise<RunCostView[]> };

const costsOfRuns = async (client: Pick<ReportClient, 'reportCost'>, runIds: readonly string[]): Promise<RunCostView[]> => {
  const costs: RunCostView[] = [];
  for (let start = 0; start < runIds.length; start += REPORT_PAGE_ROWS) costs.push(...(await client.reportCost(runIds.slice(start, start + REPORT_PAGE_ROWS))));
  return costs;
};

const aggregateAllPages = async (client: FactsPages, groupBy: GroupKey): Promise<Aggregate> => {
  let total = aggregate([], { groupBy });
  let cursor: string | null = null;
  do {
    const page: ReportPage = await client.reportFacts({ cursor, limit: REPORT_PAGE_ROWS });
    total = merge(total, aggregate(page.rows, { groupBy, unavailableRoots: page.unavailable.map((run) => run.rootRunId) }));
    cursor = page.nextCursor;
  } while (cursor !== null);
  return total;
};

const explainLines = (aggregated: Aggregate): string[] => {
  const lines = ['', 'Run ids behind each count:'];
  for (const [label, runIds] of explainOf(aggregated)) lines.push(`${label}: ${runIds.join(', ')}`);
  return lines;
};

export const reliabilityText = async (client: ReportClient, options: ReliabilityOptions, now: number): Promise<string> => {
  const period: Period = { days: options.days, fromMs: now - options.days * DAY_MS, toMs: now };
  const aggregated = withinPeriod(await aggregateAllPages(client, options.groupBy), period);
  const cost = costOf(aggregated, await costsOfRuns(client, countedRunIdsOf(aggregated)));
  const report = formatReliabilityReport(buildReliabilityReport({ kind: 'real', aggregate: aggregated, period, cost }));
  return options.explain ? `${report}${explainLines(aggregated).join('\n')}\n` : report;
};

export const showReliability = async (ports: CliPorts, paths: MomongaPaths, options: ReliabilityOptions): Promise<number> => {
  await ensureCurrentDaemon(ports, paths);
  const client = connectRuntime(ports, paths);
  try {
    ports.stdout.write(await reliabilityText(client, options, ports.clock.now()));
    return 0;
  } finally {
    await client.close();
  }
};
