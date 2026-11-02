import type { MomongaPaths } from '@momonga/foundation';
import type { PermissionOption } from '@momonga/protocol';
import { ensureDaemon } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import { connectRuntime } from '../run/open-session.ts';
import { watchRun } from '../run/headless.ts';
import type { OutputFormat } from '../run/headless.ts';
import { activeRunIdOf, latestRunIdOf } from './targets.ts';

export class UnknownOption extends Error {
  constructor(wanted: string, offered: readonly PermissionOption[]) {
    super(`option ${wanted} is not offered; choose one of ${offered.map((option) => option.kind).join(', ')}`);
    this.name = 'UnknownOption';
  }
}

export type AttachOptions = { runId?: string; format: OutputFormat; after: number; verbose: boolean; interrupt: AbortSignal };

export const attachRun = async (ports: CliPorts, paths: MomongaPaths, options: AttachOptions): Promise<number> => {
  await ensureDaemon(ports, paths);
  const client = connectRuntime(paths);
  try {
    const runId = options.runId ?? (await latestRunIdOf(client, ports.cwd));
    return await watchRun(ports, paths, { client, runId, format: options.format, verbose: options.verbose, after: options.after, interrupt: options.interrupt });
  } finally {
    await client.close();
  }
};

export const cancelRun = async (ports: CliPorts, paths: MomongaPaths, runId: string | undefined): Promise<number> => {
  await ensureDaemon(ports, paths);
  const client = connectRuntime(paths);
  try {
    const target = runId ?? (await activeRunIdOf(client, ports.cwd));
    const { status, run } = await client.cancel(target);
    ports.stdout.write(status === 202 ? `momonga: cancelling run ${run.id} (${run.status})\n` : `momonga: run ${run.id} already ${run.status}\n`);
    return 0;
  } finally {
    await client.close();
  }
};

const pendingLines = (approvalId: string, title: string, options: readonly PermissionOption[]): string =>
  [`${approvalId}  ${title}`, ...options.map((option) => `    ${option.kind}${option.name === option.kind ? '' : `  (${option.name})`}`)].join('\n');

export const approve = async (ports: CliPorts, paths: MomongaPaths, approvalId: string | undefined, option: string | undefined): Promise<number> => {
  await ensureDaemon(ports, paths);
  const client = connectRuntime(paths);
  try {
    if (approvalId === undefined) {
      const runId = await activeRunIdOf(client, ports.cwd);
      const pending = (await client.approvals(runId)).filter((approval) => approval.status === 'pending');
      ports.stdout.write(
        pending.length === 0 ? `run ${runId} has no pending approvals\n` : `${pending.map((approval) => pendingLines(approval.id, approval.toolCall.title, approval.options)).join('\n')}\n`,
      );
      return 0;
    }
    const approval = await client.getApproval(approvalId);
    if (option === undefined) {
      ports.stdout.write(`${pendingLines(approval.id, approval.toolCall.title, approval.options)}\n`);
      return 0;
    }
    const offered = approval.options.find((candidate) => candidate.optionId === option || candidate.kind === option);
    if (offered === undefined) throw new UnknownOption(option, approval.options);
    const resolved = await client.resolveApproval(approval.id, offered.optionId);
    ports.stdout.write(`approval ${resolved.approval.id} ${resolved.approval.status}: ${offered.kind}; run ${resolved.run.id} is ${resolved.run.status}\n`);
    return 0;
  } finally {
    await client.close();
  }
};
