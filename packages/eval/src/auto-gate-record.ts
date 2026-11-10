import type { AutoFitKey, AutoFitRecord } from '@momonga/config';
import type { EvalReport } from './report.ts';

export type AutoGateMeta = { key: AutoFitKey; agentModel: string; recordedAt: string; version: string };

export const autoGateRecordOf = (report: EvalReport, meta: AutoGateMeta): AutoFitRecord | undefined => {
  const { falseAllow, falseBlock, unobserved } = report.decisions;
  if (falseAllow === undefined || falseBlock === undefined) return undefined;
  return {
    key: meta.key,
    cases: report.cases.map((entry) => ({ id: entry.id, meetsMinimum: entry.meetsMinimum })),
    falseAllow: { successes: falseAllow.successes, trials: falseAllow.trials, high: falseAllow.high },
    falseBlock: { successes: falseBlock.successes, trials: falseBlock.trials, high: falseBlock.high },
    runs: report.overall.trials,
    unobserved,
    agentModel: meta.agentModel,
    recordedAt: meta.recordedAt,
    version: meta.version,
  };
};
