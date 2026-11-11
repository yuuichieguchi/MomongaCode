import type { MomongaPaths } from '@momonga/foundation';
import { usdOfNano } from '@momonga/protocol';
import type { BudgetExhausted, RunBudgetReport, RunDelegationReport, RunFailedCallReport, RunOperationReport, RunReport, RunReportAnomaly } from '@momonga/protocol';
import { ensureDaemon } from '../daemon/ensure-daemon.ts';
import { CONDITION_STATE_WORDS, RESIDUAL_RISK_WORDS } from '../policy-messages.ts';
import type { CliPorts } from '../ports.ts';
import { connectRuntime } from '../run/open-session.ts';
import { escapedLines } from '../terminal-writer.ts';
import { latestRunIdOf } from './targets.ts';

const conditionLine = (condition: RunReport['conditions'][number]): string => {
  const exit = condition.last?.exitCode === undefined ? '' : `, exit code ${condition.last.exitCode}`;
  return `  ${CONDITION_STATE_WORDS[condition.state]}  ${condition.command}  (${condition.rounds} ${condition.rounds === 1 ? 'round' : 'rounds'}${exit})`;
};

const usd = (nano: number): string => `${usdOfNano(nano)} USD`;

const ofLimit = (limit: string | undefined): string => (limit === undefined ? ', no limit' : ` of ${limit}`);

const reservedClause = (reserved: string | undefined): string => (reserved === undefined ? '' : ` (${reserved} reserved)`);

const budgetLines = (budget: RunBudgetReport): string[] => {
  const { limits, spent, reserved } = budget;
  const unpriced = spent.unpricedCalls === 0 ? '' : `; ${spent.unpricedCalls} ${spent.unpricedCalls === 1 ? 'call has' : 'calls have'} no price and ${spent.unpricedCalls === 1 ? 'is' : 'are'} not in this amount`;
  return [
    'budget (tokens and money are those of the run and its child runs):',
    `  steps  ${spent.steps}${ofLimit(limits.maxSteps === undefined ? undefined : String(limits.maxSteps))}`,
    `  tokens  ${spent.totalTokens}${ofLimit(limits.maxTotalTokens === undefined ? undefined : String(limits.maxTotalTokens))}${reservedClause(reserved.tokens === 0 ? undefined : String(reserved.tokens))}`,
    `  money  ${usd(spent.costNano)}${ofLimit(limits.maxCostNano === undefined ? undefined : usd(limits.maxCostNano))}${reservedClause(reserved.costNano === 0 ? undefined : usd(reserved.costNano))}${unpriced}`,
    `  deadline  ${new Date(limits.deadlineAt).toISOString()}`,
  ];
};

const LIMIT_WORDS: Record<BudgetExhausted['dimension'], string> = { steps: 'step', tokens: 'token', cost: 'money', time: 'time', retries: 'retry' };

const CAUSE_TEXT: Record<BudgetExhausted['cause'], string> = {
  limit: 'the limit was reached',
  unpriced: 'a model call has no price, so its cost cannot be counted',
  cap_too_small: 'what is left does not pay for another model request',
};

const figureOf = (dimension: BudgetExhausted['dimension'], value: number): string => (dimension === 'cost' ? usd(value) : dimension === 'time' ? `${value} ms` : String(value));

export const stoppedByLine = (stopped: BudgetExhausted): string =>
  `stopped by the ${LIMIT_WORDS[stopped.dimension]} limit: ${CAUSE_TEXT[stopped.cause]} (${figureOf(stopped.dimension, stopped.spent)} of ${figureOf(stopped.dimension, stopped.limit)} used or reserved)`;

const HELD_OUTCOME_TEXT = { executed: 'approved and run', rejected: 'rejected', withdrawn: 'withdrawn' } as const;

const heldLine = (held: RunDelegationReport['held'][number]): string => {
  const outcome = held.outcome === undefined ? 'still held' : held.outcome === 'executed' ? `${HELD_OUTCOME_TEXT.executed}, late result ${held.status ?? 'not recorded'}` : HELD_OUTCOME_TEXT[held.outcome];
  return `  ${held.tool}  ${outcome}  (${held.reason})`;
};

const delegationLines = (delegation: RunDelegationReport): string[] => [
  ...(delegation.held.length === 0 ? [] : ['calls held for a person:', ...delegation.held.map(heldLine)]),
  ...(delegation.denied.length === 0
    ? []
    : ['calls denied under the mandate:', ...delegation.denied.map((call) => `  ${call.tool}  ${call.source === 'mandate' ? 'outside the mandate' : 'meets a held call'}  (${call.reason})`)]),
  ...(delegation.quiescent ? ['the run finished its other work and waited for a person with calls held'] : []),
];

const EFFECT_TEXT: Record<RunOperationReport['effect'], string> = { applied: 'applied', already_applied: 'already applied', failed: 'failed', unknown: 'unknown' };

const operationLines = (operations: readonly RunOperationReport[]): string[] => [
  'Git and Pull Request operations (observed effect, destination):',
  ...operations.map((entry) => `  ${entry.operation}  ${EFFECT_TEXT[entry.effect]}  ${entry.target}`),
];

const ANOMALY_TEXT: Record<RunReportAnomaly['cause'], string> = {
  unknown_call: 'names a call the run did not announce',
  not_held: 'ends a hold the run did not open',
};

const failedCallLines = (calls: readonly RunFailedCallReport[]): string[] => ['failed calls:', ...calls.map((call) => `  ${call.tool}  ${call.callId}  (seq ${call.seq})`)];

const anomalyLines = (anomalies: readonly RunReportAnomaly[]): string[] => [
  'journal anomalies (the report shows the rest of the journal):',
  ...anomalies.map((anomaly) => `  ${anomaly.type} at seq ${anomaly.seq} ${ANOMALY_TEXT[anomaly.cause]}: ${anomaly.callId}`),
];

export const renderReport = (report: RunReport): string => {
  const outcome = report.stopReason === undefined ? report.status : `${report.status} (${report.stopReason})`;
  return escapedLines([
    `run ${report.runId}: ${outcome}, ${report.durationMs} ms`,
    ...(report.declaration === null ? ['no completion condition declared'] : []),
    ...(report.conditions.length === 0 ? [] : ['conditions:', ...report.conditions.map(conditionLine)]),
    ...(report.notRun.length === 0 ? [] : ['not run:', ...report.notRun.map((entry) => `  ${entry.what}  (${entry.reason})`)]),
    `changes: ${report.changes.mutatingCalls} mutating ${report.changes.mutatingCalls === 1 ? 'call' : 'calls'}`,
    ...report.changes.files.map((file) => `  ${file.path}${file.sha256 === undefined ? '' : `  ${file.sha256}`}`),
    ...(report.residualRisk.length === 0 ? [] : ['residual risk:', ...report.residualRisk.map((risk) => `  ${RESIDUAL_RISK_WORDS[risk.code]}  ${risk.count}`)]),
    ...(report.modelChecks.length === 0 ? [] : ['commands the model ran that equal a condition (informational, never evidence):', ...report.modelChecks.map((check) => `  ${check.command}  exit code ${check.exitCode}`)]),
    ...(report.budget === undefined ? [] : budgetLines(report.budget)),
    ...(report.stoppedBy === undefined ? [] : [stoppedByLine(report.stoppedBy)]),
    ...(report.delegation === undefined ? [] : delegationLines(report.delegation)),
    ...(report.operations === undefined ? [] : operationLines(report.operations)),
    ...(report.failedCalls === undefined ? [] : failedCallLines(report.failedCalls)),
    ...(report.anomalies === undefined ? [] : anomalyLines(report.anomalies)),
  ]);
};

export const showReport = async (ports: CliPorts, paths: MomongaPaths, runId: string | undefined, json: boolean): Promise<number> => {
  await ensureDaemon(ports, paths);
  const client = connectRuntime(ports, paths);
  try {
    const run = await client.getRun(runId ?? (await latestRunIdOf(client, ports.cwd)));
    if (run.report === undefined) throw new Error(`the runtime returned run ${run.id} without its report`);
    ports.stdout.write(`${json ? JSON.stringify(run.report) : renderReport(run.report)}\n`);
    return 0;
  } finally {
    await client.close();
  }
};
