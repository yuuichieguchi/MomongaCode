import type { RunState } from '@momonga/protocol';
import type { Run, Session } from '@momonga/store';
import type { ReleaseTarget } from '@momonga/tools';
import type { ToolRuntimePort } from '../ports.ts';

export const releaseWaitingCalls = async (input: {
  tools: Pick<ToolRuntimePort, 'envFor' | 'toolSet' | 'executor'>;
  run: Pick<Run, 'id'>;
  session: Session;
  pendingCalls: RunState['pendingCalls'];
  signal: AbortSignal;
}): Promise<void> => {
  const { tools, run, session, pendingCalls, signal } = input;
  const targets: ReleaseTarget[] = Object.entries(pendingCalls).flatMap(([callId, call]) =>
    call.status === 'awaiting_input' && call.idemKey !== undefined ? [{ callId, name: call.name, idemKey: call.idemKey }] : [],
  );
  if (targets.length === 0) return;
  const toolSet = await tools.toolSet(run.id, { signal, env: tools.envFor(session) });
  await tools.executor.release(targets, { toolSet, signal });
};
