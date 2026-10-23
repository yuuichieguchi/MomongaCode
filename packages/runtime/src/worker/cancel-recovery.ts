import type { Run, Session } from '@momonga/store';
import type { ToolCall } from '@momonga/tools';
import type { ClaimControl } from './claim-control.ts';
import type { Journal } from './journal.ts';
import { outcomePayloads } from './tool-step.ts';
import type { WorkerOptions } from './types.ts';

export type CancelRecoveryInput = {
  options: WorkerOptions;
  run: Run;
  session: Session;
  journal: Journal;
  control: ClaimControl;
};

export const reconcileStartedCalls = async ({ options, run, session, journal, control }: CancelRecoveryInput): Promise<void> => {
  const calls: ToolCall[] = Object.entries(journal.state.pendingCalls)
    .filter(([, call]) => call.status === 'started')
    .map(([callId, call]) => ({ callId, name: call.name, arguments: call.arguments }));
  if (calls.length === 0) return;
  const toolSet = await options.tools.toolSet(run.id);
  const policy = await options.tools.policyFor(session);
  await options.tools.executor.runBatch({
    calls,
    toolSet,
    runId: run.id,
    step: journal.state.step,
    mode: session.permissionMode,
    rules: await options.settings.rules(session),
    home: options.home,
    roots: policy.roots,
    env: session.env,
    session: options.tools.sessionState(session),
    sandbox: options.tools.sandbox,
    sandboxPolicy: policy.sandboxPolicy,
    deadlineAt: run.deadlineAt,
    signal: control.signal,
    protectedPaths: policy.protectedPaths,
    recoverOnly: true,
    leaseLost: () => control.leaseLost() || control.shuttingDown(),
    onOutcome: (outcome) => journal.append(outcomePayloads(outcome)),
  });
};
