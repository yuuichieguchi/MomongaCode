import type { MomongaPaths } from '@momonga/foundation';
import { escapeTerminalLine } from '@momonga/protocol';
import type { PermissionOption } from '@momonga/protocol';
import { ensureCurrentDaemon, ensureSessionDaemon } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import type { ApprovalView, RunView } from '../client/views.ts';
import { connectRuntime, connectSessionRuntime } from '../run/open-session.ts';
import { adoptionOf, refuseStart } from '../handover/start.ts';
import { newerListenerOf, streamMoveOf } from '../handover/stream.ts';
import { resumeStream, watchRun } from '../run/headless.ts';
import type { OutputFormat } from '../run/headless.ts';
import { activeRunIdOf, latestRunIdOf, runTreeOf } from './targets.ts';

export class UnknownOption extends Error {
  constructor(wanted: string, offered: readonly PermissionOption[]) {
    super(`option ${wanted} is not offered; choose one of ${offered.map((option) => option.kind).join(', ')}`);
    this.name = 'UnknownOption';
  }
}

export type AttachOptions = { runId?: string; format: OutputFormat; after: number; verbose: boolean; interrupt: AbortSignal };

export const attachRun = async (ports: CliPorts, paths: MomongaPaths, options: AttachOptions): Promise<number> => {
  const adoption = adoptionOf(ports.handover?.started, ['attach']);
  if (adoption.kind === 'refused') return refuseStart({ stderr: ports.stderr }, adoption);
  if (adoption.kind === 'record') return resumeStream(ports, paths, adoption, options.interrupt);
  const onNewer = newerListenerOf(ports);
  await ensureSessionDaemon(ports, paths, onNewer === undefined ? {} : { onNewer });
  const client = connectSessionRuntime(ports, paths, onNewer);
  const move = streamMoveOf(ports, paths, 'attach');
  try {
    const runId = options.runId ?? (await latestRunIdOf(client, ports.cwd));
    return await watchRun(ports, paths, { client, runId, format: options.format, verbose: options.verbose, after: options.after, interrupt: options.interrupt, ...(move === undefined ? {} : { move }) });
  } finally {
    await client.close();
  }
};

export const cancelRun = async (ports: CliPorts, paths: MomongaPaths, runId: string | undefined): Promise<number> => {
  await ensureCurrentDaemon(ports, paths);
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

export const pendingLines = (approval: ApprovalView, agent?: string): string =>
  [
    `${approval.id}  ${escapeTerminalLine(approval.toolCall.title)}${agent === undefined ? '' : `  (subagent ${escapeTerminalLine(agent)})`}`,
    `  ${escapeTerminalLine(approval.reason)}`,
    ...approval.options.map((option) => `    ${option.kind}${option.name === option.kind ? '' : `  (${escapeTerminalLine(option.name)})`}`),
  ].join('\n');

export const approvalLine = (depth: number, approvalId: string, title: string): string => `${'  '.repeat(depth)}approval ${approvalId}  ${escapeTerminalLine(title)}`;

export const approve = async (ports: CliPorts, paths: MomongaPaths, approvalId: string | undefined, option: string | undefined): Promise<number> => {
  await ensureCurrentDaemon(ports, paths);
  const client = connectRuntime(paths);
  try {
    if (approvalId === undefined) {
      const runId = await activeRunIdOf(client, ports.cwd);
      const tree = await runTreeOf(client, runId);
      const pending = (
        await Promise.all(
          tree.map(async ({ run }) =>
            (await client.approvals(run.id)).filter((approval) => approval.status === 'pending').map((approval) => ({ approval, agent: run.agent })),
          ),
        )
      ).flat();
      ports.stdout.write(
        pending.length === 0
          ? `run ${runId} has no pending approvals\n`
          : `${pending.map(({ approval, agent }) => pendingLines(approval, agent)).join('\n')}\n`,
      );
      return 0;
    }
    const approval = await client.getApproval(approvalId);
    if (option === undefined) {
      ports.stdout.write(`${pendingLines(approval)}\n`);
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

const runLine = ({ run, depth }: { run: RunView; depth: number }): string =>
  `${'  '.repeat(depth)}${run.id}  ${run.status}${run.agent === undefined ? '' : `  (subagent ${escapeTerminalLine(run.agent)})`}`;

export const showStatus = async (ports: CliPorts, paths: MomongaPaths, runId: string | undefined, json: boolean): Promise<number> => {
  await ensureCurrentDaemon(ports, paths);
  const client = connectRuntime(paths);
  try {
    const tree = await runTreeOf(client, runId ?? (await latestRunIdOf(client, ports.cwd)));
    const pending = await Promise.all(
      tree.map(async (node) => ({ ...node, approvals: (await client.approvals(node.run.id)).filter((approval) => approval.status === 'pending') })),
    );
    if (json) {
      ports.stdout.write(`${JSON.stringify(pending.map(({ run, approvals }) => ({ run, approvals })))}\n`);
      return 0;
    }
    ports.stdout.write(
      `${pending
        .flatMap((node) => [runLine(node), ...node.approvals.map((approval) => approvalLine(node.depth + 1, approval.id, approval.toolCall.title))])
        .join('\n')}\n`,
    );
    return 0;
  } finally {
    await client.close();
  }
};
