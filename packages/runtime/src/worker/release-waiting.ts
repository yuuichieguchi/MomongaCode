import type { RunState } from '@momonga/protocol';
import type { Run, Session } from '@momonga/store';
import type { ReleaseTarget } from '@momonga/tools';
import type { ToolRuntimePort } from '../ports.ts';

export const releaseTargetsOf = (pendingCalls: RunState['pendingCalls']): ReleaseTarget[] =>
  Object.entries(pendingCalls).flatMap(([callId, call]) =>
    call.idemKey !== undefined && call.status !== 'completed' && call.status !== 'reconciled' ? [{ callId, name: call.name, idemKey: call.idemKey }] : [],
  );

export const releaseCalls = async (input: {
  tools: Pick<ToolRuntimePort, 'envFor' | 'toolSet' | 'executor'>;
  run: Pick<Run, 'id'>;
  session: Session;
  targets: readonly ReleaseTarget[];
  signal: AbortSignal;
}): Promise<void> => {
  const { tools, run, session, targets, signal } = input;
  if (targets.length === 0) return;
  await tools.executor.release([...targets], { toolSet: async () => tools.toolSet(run.id, { signal, env: await tools.envFor(session, signal) }), signal });
};

export const releaseWaitingCalls = async (input: {
  tools: Pick<ToolRuntimePort, 'envFor' | 'toolSet' | 'executor'>;
  run: Pick<Run, 'id'>;
  session: Session;
  pendingCalls: RunState['pendingCalls'];
  signal: AbortSignal;
}): Promise<void> => {
  const { pendingCalls, ...rest } = input;
  await releaseCalls({ ...rest, targets: releaseTargetsOf(pendingCalls) });
};
