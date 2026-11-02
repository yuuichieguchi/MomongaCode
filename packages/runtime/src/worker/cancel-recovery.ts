import { isFatalStoreError } from '@momonga/store';
import type { Run, Session } from '@momonga/store';
import type { AbandonTarget, ToolCall } from '@momonga/tools';
import type { ClaimControl } from './claim-control.ts';
import { describeError, LeaseLostError, ShutdownError } from './errors.ts';
import type { Journal } from './journal.ts';
import { reportError } from './report.ts';
import { releaseWaitingCalls } from './release-waiting.ts';
import { outcomePayloads } from './tool-step.ts';
import type { WorkerOptions } from './types.ts';

export type CancelRecoveryInput = {
  options: WorkerOptions;
  run: Run;
  session: Session;
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
        message: `Calls waiting for input could not be released before the run was cancelled: ${describeError(error)}${
          hookFailure === undefined ? '' : ` (the error hook also failed: ${hookFailure})`
        }`,
      },
    ]);
  }
};

export const reconcileStartedCalls = async ({ options, run, session, journal, control }: CancelRecoveryInput): Promise<void> => {
  const started: StartedCall[] = Object.entries(journal.state.pendingCalls)
    .filter(([, call]) => call.status === 'started')
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
      const context = await tools.recoveryContextFor(session, { env });
      await tools.executor.runBatch({
        calls: recoverable.map(({ callId, name, arguments: args }) => ({ callId, name, arguments: args })),
        toolSet,
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
        leaseLost: () => control.leaseLost() || control.shuttingDown(),
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
