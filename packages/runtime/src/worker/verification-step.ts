import path from 'node:path';
import { newCallId, reapMarkedProcesses } from '@momonga/foundation';
import { VERIFICATION_FEEDBACK_PREFIX, conditionOwed, failureBeforeRound, openRoundOf } from '@momonga/protocol';
import type { ConditionResult, PinnedCondition, RunEventPayload, VerificationOutcome } from '@momonga/protocol';
import { EarlierAttemptNotStoppedError, runSandboxedCommand, verificationMarkerName } from '@momonga/tools';
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
    inspector: ctx.options.tools.inspector,
  });
  if (!removed) throw new EarlierAttemptNotStoppedError(`a completion check of run ${ctx.run.id} left by an earlier attempt could not be stopped: ${warnings.join('; ')}`, 'survived');
};

type Round = { round: number; mutationSeq: number; commands: SessionCommands };

type Closing = (checked: Checked) => RunEventPayload[];

const runCheck = async (ctx: ClaimContext, condition: PinnedCondition, attempt: number, round: Round, closing: Closing): Promise<Checked | 'interrupted'> => {
  const checkName = verificationMarkerName({ runId: ctx.run.id, round: round.round, conditionId: condition.id });
  const lock = await ctx.options.tools.executor.holdCall(checkName, ctx.control.signal);
  if (lock === 'aborted') return 'interrupted';
  try {
    return await runHeldCheck(ctx, condition, attempt, round, checkName, closing);
  } finally {
    lock.release();
  }
};

const runHeldCheck = async (
  ctx: ClaimContext,
  condition: PinnedCondition,
  attempt: number,
  { round, mutationSeq, commands }: Round,
  checkName: string,
  closing: Closing,
): Promise<Checked | 'interrupted'> => {
  const { clock, tools } = ctx.options;
  const { bash } = await ctx.options.settings.tools(commands.session, ctx.control.signal);
  const marker = path.join(tools.markerDir, checkName);
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
    timeoutMs: Math.min(condition.timeoutMs ?? bash.maxTimeoutMs, ctx.run.deadlineAt - clock.now()),
    tmpDir: commands.policy.tmpDir,
    inspector: tools.inspector,
    ...(tools.owners === undefined ? {} : { owners: tools.owners }),
  });
  if (result.kind === 'cancelled') return 'interrupted';
  const { outcome, exitCode } = outcomeOf(result);
  const output = outputOf(result);
  const call = { callId: newCallId(clock), tool: CHECK_OUTPUT_TOOL };
  const fits = await ctx.outputFit.fits(output, call);
  const handle = fits ? undefined : (await ctx.options.blobs.put(output, { mediaType: OUTPUT_MEDIA_TYPE, runId: ctx.run.id })).handle;
  const inline = handle === undefined ? output : await ctx.outputFit.fit(output, handle, call);
  const checked: Checked = { condition, outcome, exitCode, output: inline };
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
    ...closing(checked),
  ]);
  return checked;
};

export const NO_CHECK_DECLARED_CODE = 'no_check_declared';

const NO_CHECK_DECLARED_NOTICE =
  'The run changed the workspace and no check is declared for this folder, so the run is unverified and nothing is learned from it. To declare one, accept the check the terminal UI proposes when it starts in this folder, or set verification.commands in the settings.';

type Decision = 'proceed' | 'timeout' | 'unmet' | 'continue';

const verifyCompletion = async (ctx: ClaimContext): Promise<'proceed' | Flow> => {
  const { conditions, required } = ctx.completion;
  const { lastMutationSeq } = ctx.journal.state;
  if (conditions.length === 0) {
    if (lastMutationSeq === 0) return 'proceed';
    if (!required) {
      if (!ctx.journal.state.notes.some((note) => note.code === NO_CHECK_DECLARED_CODE)) {
        ctx.journal.append([{ type: 'notice', level: 'info', message: NO_CHECK_DECLARED_NOTICE, code: NO_CHECK_DECLARED_CODE }]);
      }
      return 'proceed';
    }
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
  const { verification } = ctx.journal.state;
  const owedGiven = (checked: readonly Checked[]): PinnedCondition[] =>
    conditions.filter((condition) => {
      const fresh = checked.find((entry) => entry.condition.id === condition.id);
      const result: ConditionResult | undefined = fresh === undefined ? verification.results[condition.id] : { seq: 0, outcome: fresh.outcome, mutationSeq: lastMutationSeq };
      return conditionOwed(condition, lastMutationSeq, result);
    });
  const owed = owedGiven([]);
  if (owed.length === 0) return 'proceed';
  const { pending } = verification;
  const toRun = owed.filter((condition) => verification.results[condition.id]?.mutationSeq !== lastMutationSeq || pending?.[condition.id] !== undefined);
  if (toRun.length === 0) return stopped(ctx, 'conditions_unmet');

  const round = openRoundOf(verification, lastMutationSeq) ?? verification.round + 1;
  const earlierFailure = failureBeforeRound(verification, round);
  const changedSinceEarlierFailure = earlierFailure === undefined || lastMutationSeq > earlierFailure;
  const results: Checked[] = [];
  const decided: { value: Decision } = { value: 'proceed' };
  const decide = (): RunEventPayload[] => {
    const stillOwed = owedGiven(results);
    if (stillOwed.length === 0) return [];
    if (results.some((entry) => entry.outcome === 'timed_out') && ctx.options.clock.now() >= ctx.run.deadlineAt) {
      decided.value = 'timeout';
      return [];
    }
    if (!changedSinceEarlierFailure) {
      decided.value = 'unmet';
      return [];
    }
    decided.value = 'continue';
    const failures = results.filter((entry) => entry.outcome !== 'passed');
    const unchecked = stillOwed.filter((condition) => !results.some((entry) => entry.condition.id === condition.id));
    return [feedbackFor(failures, unchecked)];
  };

  const checked = await withSessionCommands(ctx, async (commands): Promise<'checked' | 'interrupted'> => {
    for (const [index, condition] of toRun.entries()) {
      const attempt = (pending?.[condition.id]?.attempt ?? 0) + 1;
      const closesRound = index === toRun.length - 1;
      const result = await runCheck(ctx, condition, attempt, { round, mutationSeq: lastMutationSeq, commands }, (entry) => {
        results.push(entry);
        return closesRound ? decide() : [];
      });
      if (result === 'interrupted') return 'interrupted';
    }
    return 'checked';
  });
  if (checked === 'interrupted') {
    const interrupted = await cancelIfInterrupted(ctx);
    if (interrupted === undefined) throw new Error(`a completion check of run ${ctx.run.id} was cancelled although the run was not interrupted`);
    return interrupted;
  }
  if (decided.value === 'timeout') return stopped(ctx, 'timeout');
  if (decided.value === 'unmet') return stopped(ctx, 'conditions_unmet');
  return decided.value;
};

export const stopGate = async (ctx: ClaimContext): Promise<'allow' | Flow> => {
  const verified = await verifyCompletion(ctx);
  return verified === 'proceed' ? runStopHooks(ctx) : verified;
};
