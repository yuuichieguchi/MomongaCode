import path from 'node:path';
import type { MomongaPaths } from '@momonga/foundation';
import { EXIT_FAILURE, EXIT_OK } from '@momonga/foundation';
import { REPORT_PAGE_ROWS, escapeTerminalLine } from '@momonga/protocol';
import type { ReportPage, ReportRecomputePage, RunCostView, RunFactsView } from '@momonga/protocol';
import { aggregate, buildReliabilityReport, costOf, countedRunIdsOf, encodeReliabilityReport, explainOf, formatReliabilityReport, merge, mergeVerifications, verifyFacts, withinPeriod } from '@momonga/reliability';
import type { Aggregate, FactsVerification, Period, ReliabilityReport, RunGroupKey } from '@momonga/reliability';
import { ensureCurrentDaemon } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import { connectRuntime } from '../run/open-session.ts';

export type ReliabilityOptions = { groupBy: RunGroupKey; explain: boolean; days: number; json: boolean; out?: string };

export const DEFAULT_REPORT_DAYS = 30;

const DAY_MS = 86_400_000;

const LATEST_DATE_VALUE = 8.64e15;

export const MAX_REPORT_DAYS = Math.floor(LATEST_DATE_VALUE / DAY_MS);

export type FactsPages = { reportFacts(request: { cursor: string | null; limit: number }): Promise<ReportPage> };

export type ReportClient = FactsPages & { reportCost(runIds: readonly string[]): Promise<RunCostView[]> };

export type VerifyClient = FactsPages & { reportRecompute(runIds: readonly string[]): Promise<ReportRecomputePage> };

const costsOfRuns = async (client: Pick<ReportClient, 'reportCost'>, runIds: readonly string[]): Promise<RunCostView[]> => {
  const costs: RunCostView[] = [];
  for (let start = 0; start < runIds.length; start += REPORT_PAGE_ROWS) costs.push(...(await client.reportCost(runIds.slice(start, start + REPORT_PAGE_ROWS))));
  return costs;
};

const aggregateAllPages = async (client: FactsPages, groupBy: RunGroupKey): Promise<Aggregate> => {
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
  for (const [label, runIds] of explainOf(aggregated)) lines.push(`${label}: ${runIds.map(escapeTerminalLine).join(', ')}`);
  return lines;
};

type BuiltReport = { report: ReliabilityReport; aggregated: Aggregate };

const builtReport = async (client: ReportClient, options: Pick<ReliabilityOptions, 'groupBy' | 'days'>, now: number): Promise<BuiltReport> => {
  const period: Period = { days: options.days, fromMs: now - options.days * DAY_MS, toMs: now };
  const aggregated = withinPeriod(await aggregateAllPages(client, options.groupBy), period);
  const cost = costOf(aggregated, await costsOfRuns(client, countedRunIdsOf(aggregated)));
  return { report: buildReliabilityReport({ kind: 'real', aggregate: aggregated, period, cost }), aggregated };
};

const shownText = ({ report, aggregated }: BuiltReport, options: Pick<ReliabilityOptions, 'explain' | 'json'>): string => {
  if (options.json) return `${encodeReliabilityReport(report)}\n`;
  const text = formatReliabilityReport(report);
  return options.explain ? `${text}${explainLines(aggregated).join('\n')}\n` : text;
};

export const reliabilityText = async (client: ReportClient, options: ReliabilityOptions, now: number): Promise<string> => shownText(await builtReport(client, options, now), options);

export type ReliabilitySinks = Pick<CliPorts, 'cwd' | 'stdout'> & { files: Pick<CliPorts['files'], 'writeText'> };

export const emitReliability = async (sinks: ReliabilitySinks, client: ReportClient, options: ReliabilityOptions, now: number): Promise<void> => {
  const built = await builtReport(client, options, now);
  if (options.out !== undefined) await sinks.files.writeText(path.resolve(sinks.cwd, options.out), encodeReliabilityReport(built.report));
  sinks.stdout.write(shownText(built, options));
};

const verifiedPage = async (client: VerifyClient, rows: readonly RunFactsView[]): Promise<FactsVerification> => {
  let verification: FactsVerification = { checked: 0, stale: [], refused: [], mismatches: [] };
  for (let start = 0; start < rows.length; start += REPORT_PAGE_ROWS) {
    const batch = rows.slice(start, start + REPORT_PAGE_ROWS);
    verification = mergeVerifications(verification, verifyFacts(batch, await client.reportRecompute(batch.map((row) => row.runId))));
  }
  return verification;
};

const verificationLines = (verification: FactsVerification): string[] => [
  `Stored facts against the journal: ${verification.checked} runs recomputed; ${verification.mismatches.length} differ; ${verification.stale.length} of an older definitions version (folded again by the daemon); ${verification.refused.length} refused by the journal`,
  ...verification.mismatches.map((mismatch) => `${escapeTerminalLine(mismatch.runId)}: ${mismatch.fields.join(', ')}`),
  ...verification.refused.map((runId) => `${escapeTerminalLine(runId)}: refused by the journal`),
];

export const verifyReliability = async (client: VerifyClient): Promise<{ text: string; code: number }> => {
  let verification: FactsVerification = { checked: 0, stale: [], refused: [], mismatches: [] };
  let cursor: string | null = null;
  do {
    const page: ReportPage = await client.reportFacts({ cursor, limit: REPORT_PAGE_ROWS });
    verification = mergeVerifications(verification, await verifiedPage(client, page.rows));
    cursor = page.nextCursor;
  } while (cursor !== null);
  return { text: `${verificationLines(verification).join('\n')}\n`, code: verification.mismatches.length === 0 ? EXIT_OK : EXIT_FAILURE };
};

export const showReliability = async (ports: CliPorts, paths: MomongaPaths, options: ReliabilityOptions): Promise<number> => {
  await ensureCurrentDaemon(ports, paths);
  const client = connectRuntime(ports, paths);
  try {
    await emitReliability(ports, client, options, ports.clock.now());
    return EXIT_OK;
  } finally {
    await client.close();
  }
};

export const showReliabilityVerification = async (ports: CliPorts, paths: MomongaPaths): Promise<number> => {
  await ensureCurrentDaemon(ports, paths);
  const client = connectRuntime(ports, paths);
  try {
    const { text, code } = await verifyReliability(client);
    ports.stdout.write(text);
    return code;
  } finally {
    await client.close();
  }
};
