import path from 'node:path';
import { newCallId, reapMarkedProcesses } from '@momonga/foundation';
import { VERIFICATION_FEEDBACK_PREFIX, conditionOwed } from '@momonga/protocol';
import type { ConditionResult, PinnedCondition, RunEventPayload, VerificationOutcome } from '@momonga/protocol';
import { MAX_COMMAND_TIMEOUT_MS, runSandboxedCommand, verificationMarkerName } from '@momonga/tools';
import type { SandboxedCommandResult } from '@momonga/tools';
import { MARKER_REAP_KILL_GRACE_MS } from '../process/constants.ts';
import type { ClaimContext, Flow } from './claim-context.ts';
import { cancelIfInterrupted } from './context-step.ts';
import { runStopHooks, withSessionCommands } from './hook-step.ts';
import type { SessionCommands } from './hook-step.ts';

const OUTPUT_MEDIA_TYPE = 'text/plain; charset=utf-8';

const CHECK_OUTPUT_TOOL = 'Bash';

type Checked = { condition: PinnedCondition; outcome: VerificationOutcome; exitCode: number | undefined; output: string };

type Finished = Exclude<SandboxedCommandResult, { kind: 'cancelled' }>;

const joined = (parts: readonly string[]): string => parts.filter((part) => part !== '').join('\n');

const outputOf = (result: Finished): string => {
  switch (result.kind) {
    case 'exited':
    case 'timed_out':
      return joined([result.stdout, result.stderr]);
    case 'signaled':
      return joined([`[terminated by ${result.signal}]`, result.stdout, result.stderr]);
    case 'spawn_error':
      return result.message;
  }
};

const outcomeOf = (result: Finished): { outcome: VerificationOutcome; exitCode: number | undefined } => {
  switch (result.kind) {
    case 'exited':
      return { outcome: result.exitCode === 0 ? 'passed' : 'failed', exitCode: result.exitCode };
    case 'signaled':
      return { outcome: 'failed', exitCode: undefined };
    case 'timed_out':
      return { outcome: 'timed_out', exitCode: undefined };
    case 'spawn_error':
      return { outcome: 'spawn_error', exitCode: undefined };
  }
};

const stopped = (ctx: ClaimContext, reason: 'conditions_unmet' | 'timeout'): Promise<Flow> => ctx.terminals.finish('STOPPED', { stopReason: reason });

const detailOf = (checked: Checked): string => {
  if (checked.outcome === 'failed') return checked.exitCode === undefined ? 'failed' : `failed with exit code ${checked.exitCode}`;
  if (checked.outcome === 'timed_out') return 'timed out';
  if (checked.outcome === 'spawn_error') return 'could not be started';
  return checked.outcome;
};

const describeFailure = (checked: Checked): string => `- ${checked.condition.command}: ${detailOf(checked)}${checked.output === '' ? '' : `\n${checked.output}`}`;

const feedbackFor = (failures: readonly Checked[], unchecked: readonly PinnedCondition[]): RunEventPayload => ({
  type: 'user.message',
  text: [
    `${VERIFICATION_FEEDBACK_PREFIX}The task is not complete: the completion conditions declared for it did not pass. Change the workspace so they pass.`,
    ...failures.map(describeFailure),
    ...unchecked.map((condition) => `- ${condition.command}: failed on the current workspace`),
  ].join('\n'),
});

const reapStaleCheck = async (ctx: ClaimContext, marker: string): Promise<void> => {
  const warnings: string[] = [];
  const { removed } = await reapMarkedProcesses({
    marker,
    killGraceMs: MARKER_REAP_KILL_GRACE_MS,
    label: 'completion check',
    onWarning: (message) => warnings.push(message),
    signal: ctx.control.signal,
    ...(ctx.options.tools.inspector === undefined ? {} : { inspector: ctx.options.tools.inspector }),
  });
  if (!removed) throw new Error(`a completion check of run ${ctx.run.id} left by an earlier attempt could not be stopped: ${warnings.join('; ')}`);
};

type Round = { round: number; mutationSeq: number; commands: SessionCommands };

const runCheck = async (ctx: ClaimContext, condition: PinnedCondition, attempt: number, { round, mutationSeq, commands }: Round): Promise<Checked | 'interrupted'> => {
  const { clock, tools } = ctx.options;
  const markerName = verificationMarkerName({ runId: ctx.run.id, round, conditionId: condition.id });
  const marker = path.join(tools.markerDir, markerName);
  await reapStaleCheck(ctx, marker);
  ctx.journal.append([{ type: 'verification.started', round, conditionId: condition.id, command: condition.command, mutationSeq, attempt }]);
  const result = await runSandboxedCommand({
    command: condition.command,
    sandbox: commands.sandbox,
    sandboxPolicy: commands.policy.sandboxPolicy,
    env: commands.policy.env,
    shellHost: tools.shellHost,
    cwd: tools.sessionState(commands.session).cwd,
    markerFile: marker,
    clock,
    signal: ctx.control.signal,
    timeoutMs: Math.min(condition.timeoutMs ?? MAX_COMMAND_TIMEOUT_MS, ctx.run.deadlineAt - clock.now()),
    tmpDir: commands.policy.tmpDir,
    ...(tools.inspector === undefined ? {} : { inspector: tools.inspector }),
    ...(tools.owners === undefined ? {} : { owners: tools.owners }),
  });
  if (result.kind === 'cancelled') return 'interrupted';
  const { outcome, exitCode } = outcomeOf(result);
  const output = outputOf(result);
  const call = { callId: newCallId(clock), tool: CHECK_OUTPUT_TOOL };
  const fits = await ctx.outputFit.fits(output, call);
  const handle = fits ? undefined : (await ctx.options.blobs.put(output, { mediaType: OUTPUT_MEDIA_TYPE, runId: ctx.run.id })).handle;
  const inline = handle === undefined ? output : await ctx.outputFit.fit(output, handle, call);
  ctx.journal.append([
    {
      type: 'verification.completed',
      round,
      conditionId: condition.id,
      command: condition.command,
      outcome,
      ...(exitCode === undefined ? {} : { exitCode }),
      durationMs: result.durationMs,
      output: inline,
      ...(handle === undefined ? {} : { truncated: true as const, handle }),
      mutationSeq,
    },
  ]);
  return { condition, outcome, exitCode, output: inline };
};

const verifyCompletion = async (ctx: ClaimContext): Promise<'proceed' | Flow> => {
  const { conditions, required } = ctx.completion;
  const { lastMutationSeq } = ctx.journal.state;
  if (conditions.length === 0) {
    if (!required || lastMutationSeq === 0) return 'proceed';
    ctx.journal.append([
      {
        type: 'notice',
        level: 'warning',
        message: 'The run changed the workspace but no completion condition was declared for it, so it is not treated as complete.',
        code: 'conditions_not_declared',
      },
    ]);
    return stopped(ctx, 'conditions_unmet');
  }
  const resultOf = (id: string): ConditionResult | undefined => ctx.journal.state.verification.results[id];
  const owedNow = (): PinnedCondition[] => conditions.filter((condition) => conditionOwed(condition, lastMutationSeq, resultOf(condition.id)));
  const owed = owedNow();
  if (owed.length === 0) return 'proceed';
  const { pending, lastFailedRoundMutationSeq } = ctx.journal.state.verification;
  const toRun = owed.filter((condition) => resultOf(condition.id)?.mutationSeq !== lastMutationSeq || pending?.[condition.id] !== undefined);
  if (toRun.length === 0) return stopped(ctx, 'conditions_unmet');

  const openRounds = Object.values(pending ?? {}).map((check) => check.round);
  const round = openRounds.length > 0 ? Math.max(...openRounds) : ctx.journal.state.verification.round + 1;

  const checked = await withSessionCommands(ctx, async (commands): Promise<Checked[] | 'interrupted'> => {
    const results: Checked[] = [];
    for (const condition of toRun) {
      const attempt = (pending?.[condition.id]?.attempt ?? 0) + 1;
      const result = await runCheck(ctx, condition, attempt, { round, mutationSeq: lastMutationSeq, commands });
      if (result === 'interrupted') return 'interrupted';
      results.push(result);
    }
    return results;
  });
  if (checked === 'interrupted') {
    const interrupted = await cancelIfInterrupted(ctx);
    if (interrupted === undefined) throw new Error(`a completion check of run ${ctx.run.id} was cancelled although the run was not interrupted`);
    return interrupted;
  }

  const stillOwed = owedNow();
  if (stillOwed.length === 0) return 'proceed';
  if (checked.some((entry) => entry.outcome === 'timed_out') && ctx.options.clock.now() >= ctx.run.deadlineAt) return stopped(ctx, 'timeout');
  const failures = checked.filter((entry) => entry.outcome !== 'passed');
  const unchecked = stillOwed.filter((condition) => !checked.some((entry) => entry.condition.id === condition.id));
  const changedSinceLastFailure = lastFailedRoundMutationSeq === undefined || lastMutationSeq > lastFailedRoundMutationSeq;
  if (!changedSinceLastFailure) return stopped(ctx, 'conditions_unmet');
  ctx.journal.append([feedbackFor(failures, unchecked)]);
  return 'continue';
};

export const stopGate = async (ctx: ClaimContext): Promise<'allow' | Flow> => {
  const verified = await verifyCompletion(ctx);
  return verified === 'proceed' ? runStopHooks(ctx) : verified;
};
