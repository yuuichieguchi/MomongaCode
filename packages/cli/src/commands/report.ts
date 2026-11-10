import type { MomongaPaths } from '@momonga/foundation';
import type { RunReport } from '@momonga/protocol';
import { ensureDaemon } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import { connectRuntime } from '../run/open-session.ts';
import { escapedLines } from '../terminal-writer.ts';
import { latestRunIdOf } from './targets.ts';

const conditionLine = (condition: RunReport['conditions'][number]): string => {
  const exit = condition.last?.exitCode === undefined ? '' : `, exit code ${condition.last.exitCode}`;
  return `  ${condition.state}  ${condition.command}  (${condition.rounds} ${condition.rounds === 1 ? 'round' : 'rounds'}${exit})`;
};

export const renderReport = (report: RunReport): string => {
  const outcome = report.stopReason === undefined ? report.status : `${report.status} (${report.stopReason})`;
  return escapedLines([
    `run ${report.runId}: ${outcome}, ${report.durationMs} ms`,
    ...(report.declaration === null ? ['no completion condition declared'] : []),
    ...(report.conditions.length === 0 ? [] : ['conditions:', ...report.conditions.map(conditionLine)]),
    ...(report.notRun.length === 0 ? [] : ['not run:', ...report.notRun.map((entry) => `  ${entry.what}  (${entry.reason})`)]),
    `changes: ${report.changes.mutatingCalls} mutating ${report.changes.mutatingCalls === 1 ? 'call' : 'calls'}`,
    ...report.changes.files.map((file) => `  ${file.path}${file.sha256 === undefined ? '' : `  ${file.sha256}`}`),
    ...(report.residualRisk.length === 0 ? [] : ['residual risk:', ...report.residualRisk.map((risk) => `  ${risk.code}  ${risk.count}`)]),
    ...(report.modelChecks.length === 0 ? [] : ['commands the model ran that equal a condition (informational, never evidence):', ...report.modelChecks.map((check) => `  ${check.command}  exit code ${check.exitCode}`)]),
  ]);
};

export const showReport = async (ports: CliPorts, paths: MomongaPaths, runId: string | undefined, json: boolean): Promise<number> => {
  await ensureDaemon(ports, paths);
  const client = connectRuntime(paths);
  try {
    const run = await client.getRun(runId ?? (await latestRunIdOf(client, ports.cwd)));
    if (run.report === undefined) throw new Error(`the runtime returned run ${run.id} without its report`);
    ports.stdout.write(`${json ? JSON.stringify(run.report) : renderReport(run.report)}\n`);
    return 0;
  } finally {
    await client.close();
  }
};
