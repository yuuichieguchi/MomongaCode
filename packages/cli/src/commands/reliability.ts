import type { MomongaPaths } from '@momonga/foundation';
import { REPORT_PAGE_ROWS } from '@momonga/protocol';
import type { ReportPage } from '@momonga/protocol';
import { aggregate, buildReliabilityReport, explainOf, formatReliabilityReport, merge } from '@momonga/reliability';
import type { Aggregate, GroupKey } from '@momonga/reliability';
import { ensureCurrentDaemon } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import { connectRuntime } from '../run/open-session.ts';

export type ReliabilityOptions = { groupBy: GroupKey; explain: boolean };

export type FactsPages = { reportFacts(request: { cursor: string | null; limit: number }): Promise<ReportPage> };

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

export const reliabilityText = async (client: FactsPages, options: ReliabilityOptions): Promise<string> => {
  const aggregated = await aggregateAllPages(client, options.groupBy);
  const report = formatReliabilityReport(buildReliabilityReport({ kind: 'real', aggregate: aggregated }));
  return options.explain ? `${report}${explainLines(aggregated).join('\n')}\n` : report;
};

export const showReliability = async (ports: CliPorts, paths: MomongaPaths, options: ReliabilityOptions): Promise<number> => {
  await ensureCurrentDaemon(ports, paths);
  const client = connectRuntime(paths);
  try {
    ports.stdout.write(await reliabilityText(client, options));
    return 0;
  } finally {
    await client.close();
  }
};
