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
  await options.tools.executor.runBatch({
    calls,
    toolSet,
    runId: run.id,
    step: journal.state.step,
    mode: session.permissionMode,
    rules: await options.settings.rules(session),
    home: options.home,
    roots: [session.cwd],
    env: session.env,
    session: options.tools.sessionState(session),
    sandbox: options.tools.sandbox,
    sandboxPolicy: options.tools.sandboxPolicy,
    deadlineAt: run.deadlineAt,
    signal: new AbortController().signal,
    protectedPaths: options.tools.protectedPaths,
    recoverOnly: true,
    leaseLost: () => control.leaseLost(),
    onOutcome: (outcome) => journal.append(outcomePayloads(outcome)),
  });
};
