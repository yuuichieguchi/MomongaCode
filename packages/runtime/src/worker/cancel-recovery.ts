import { childToolResultOf } from '@momonga/agents';
import { isFatalStoreError } from '@momonga/store';
import type { Claim, Run } from '@momonga/store';
import type { HeldSession } from './known.ts';
import type { AbandonTarget, ResultOutcome, ToolCall } from '@momonga/tools';
import type { ClaimControl } from './claim-control.ts';
import { describeError, LeaseLostError, ShutdownError } from './errors.ts';
import type { Journal } from './journal.ts';
import { reconcileOutputFit } from './output-fit.ts';
import { readPins } from './pins.ts';
import { reportError } from './report.ts';
import { releaseWaitingCalls } from './release-waiting.ts';
import { offeredOfRequest, outcomePayloads } from './tool-step.ts';
import type { WorkerOptions } from './types.ts';

export type CancelRecoveryInput = {
  options: WorkerOptions;
  claim: Claim;
  run: Run;
  session: HeldSession;
  journal: Journal;
  control: ClaimControl;
};

const ABANDONED_OUTPUT =
  'The call was interrupted and could not be reconciled before the run was cancelled. Its effect is unknown; inspect the current state before retrying it.';

type StartedCall = ToolCall & { idemKey?: string };

const yieldsOrFails = (control: ClaimControl, error: unknown): boolean =>
  error instanceof LeaseLostError || error instanceof ShutdownError || control.leaseLost() || control.shuttingDown() || isFatalStoreError(error);

export const releaseWaitingOnCancel = async ({ options, run, session, journal, control }: CancelRecoveryInput): Promise<void> => {
  try {
    await releaseWaitingCalls({
      tools: options.tools,
      run,
      session,
      pendingCalls: journal.state.pendingCalls,
      signal: control.recoverySignal,
    });
  } catch (error) {
    if (yieldsOrFails(control, error)) throw error;
    const hookFailure = reportError(options, error, { workerId: options.workerId, runId: run.id });
    journal.append([
      {
        type: 'notice',
        level: 'error',
        code: 'waiting_calls_not_released',
        message: `Calls waiting for input could not be released before the run was cancelled: ${describeError(error)}${
          hookFailure === undefined ? '' : ` (the error hook also failed: ${hookFailure})`
        }`,
      },
    ]);
  }
};

export const reconcileStartedCalls = async ({ options, claim, run, session, journal, control }: CancelRecoveryInput): Promise<void> => {
  const startedEntries = Object.entries(journal.state.pendingCalls).filter(([, call]) => call.status === 'started');
  for (const [callId, call] of startedEntries) {
    if (call.awaiting?.kind !== 'run') continue;
    const { agents } = options;
    if (agents === undefined) throw new Error(`call ${callId} awaits subagent ${call.awaiting.agent} but the worker has no agents port`);
    const child = await agents.runs.outcomeOf(call.awaiting.runId);
    const result = child.state === 'finished' ? childToolResultOf(call.awaiting.agent, child) : { status: 'failed' as const, output: `Subagent ${call.awaiting.agent} was cancelled.` };
    const outcome: ResultOutcome = { callId, kind: 'result', result, ...(call.idemKey === undefined ? {} : { idemKey: call.idemKey }) };
    const lookup = call.idemKey === undefined ? undefined : options.store.idempotency.get(call.idemKey);
    if (call.idemKey !== undefined && lookup !== undefined && lookup.s !== 'COMPLETED') {
      if (options.store.idempotency.holding(claim).complete(call.idemKey, outcome).kind === 'lease_lost') control.lost();
    }
    journal.append(outcomePayloads(outcome));
  }
  const started: StartedCall[] = startedEntries
    .filter(([, call]) => call.awaiting?.kind !== 'run')
    .map(([callId, call]) => ({
      callId,
      name: call.name,
      arguments: call.arguments,
      ...(call.idemKey === undefined ? {} : { idemKey: call.idemKey }),
    }));
  if (started.length === 0) return;
  const settled = new Set<string>();
  const failures: Array<{ error: unknown; hookFailure: string | undefined }> = [];

  const absorb = (error: unknown): void => {
    if (yieldsOrFails(control, error)) throw error;
    failures.push({ error, hookFailure: reportError(options, error, { workerId: options.workerId, runId: run.id }) });
  };

  try {
    const { tools } = options;
    const env = tools.envFor(session);
    const recoveryTool = (await options.skills.load(session)).recoveryTool();
    const toolSet = await tools.recoveryToolSet({
      signal: control.recoverySignal,
      ...(recoveryTool === undefined ? {} : { additionalTools: [recoveryTool] }),
    });
    const recoverable = started.filter((call) => toolSet.get(call.name) !== undefined);
    if (recoverable.length > 0) {
      const context = await tools.recoveryContextFor(session, { env, signal: control.recoverySignal });
      const recorded = journal.state.pins;
      if (recorded === undefined) throw new Error(`run ${run.id} has started calls but no recorded pins`);
      const reconcileFit = reconcileOutputFit(readPins(recorded).capabilities);
      await tools.executor.runBatch({
        calls: recoverable.map(({ callId, name, arguments: args }) => ({ callId, name, arguments: args })),
        toolSet,
        fence: claim,
        runId: run.id,
        step: journal.state.step,
        mode: session.permissionMode,
        rules: [],
        home: options.home,
        roots: context.roots,
        tmpDir: context.tmpDir,
        env: context.env,
        session: tools.sessionState(session),
        deadlineAt: run.deadlineAt,
        signal: control.recoverySignal,
        recoverOnly: true,
        outputFit: reconcileFit,
        reconcileFit,
        offered: offeredOfRequest(options.store, run.id, journal.state.lastSeq),
        leaseLost: () => control.leaseLost() || control.shuttingDown(),
        onLeaseLost: control.noteLeaseLost,
        onOutcome: (outcome) => {
          settled.add(outcome.callId);
          journal.append(outcomePayloads(outcome));
        },
      });
    }
  } catch (error) {
    absorb(error);
  }

  const unsettled = started.filter((call) => !settled.has(call.callId));
  if (unsettled.length === 0) return;
  if (control.leaseLost()) throw new LeaseLostError();
  if (control.shuttingDown()) throw new ShutdownError();

  const targets: AbandonTarget[] = unsettled.flatMap((call) => (call.idemKey === undefined ? [] : [{ callId: call.callId, idemKey: call.idemKey }]));
  if (targets.length > 0) {
    try {
      await options.tools.executor.abandon(targets, { signal: control.recoverySignal });
    } catch (error) {
      absorb(error);
    }
  }

  journal.append([
    ...failures.slice(0, 1).map(({ error, hookFailure }) => ({
      type: 'notice' as const,
      level: 'error' as const,
      code: 'started_calls_not_reconciled',
      message: `Started tool calls could not be reconciled before the run was cancelled: ${describeError(error)}${
        hookFailure === undefined ? '' : ` (the error hook also failed: ${hookFailure})`
      }`,
    })),
    ...unsettled.map((call) => ({
      type: 'tool.reconciled' as const,
      callId: call.callId,
      outcome: 'unknown' as const,
      output: ABANDONED_OUTPUT,
    })),
  ]);
};
