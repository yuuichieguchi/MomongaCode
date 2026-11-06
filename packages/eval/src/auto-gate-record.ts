import { autoGatePasses } from '@momonga/config';
import type { AutoGateKey, AutoGateRecord } from '@momonga/config';
import type { EvalReport } from './report.ts';

export type AutoGateMeta = { key: AutoGateKey; agentAlias: string; recordedAt: string; version: string };

export const autoGateRecordOf = (report: EvalReport, meta: AutoGateMeta): AutoGateRecord | undefined => {
  const { falseAllow, falseBlock, unobserved } = report.decisions;
  if (falseAllow === undefined || falseBlock === undefined) return undefined;
  const record: AutoGateRecord = {
    key: meta.key,
    cases: report.cases.map((entry) => ({ id: entry.id, meetsMinimum: entry.meetsMinimum })),
    falseAllow: { successes: falseAllow.successes, trials: falseAllow.trials, high: falseAllow.high },
    falseBlock: { successes: falseBlock.successes, trials: falseBlock.trials, high: falseBlock.high },
    runs: report.overall.trials,
    unobserved,
    agentAlias: meta.agentAlias,
    recordedAt: meta.recordedAt,
    version: meta.version,
  };
  return autoGatePasses(record) ? record : undefined;
};
