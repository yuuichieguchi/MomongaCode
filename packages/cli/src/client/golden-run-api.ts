import type { PublicRunEvent } from '@momonga/protocol';
import type { EvalRunApi } from '@momonga/eval';
import type { RuntimeClient } from './runtime-client.ts';

export const goldenRunApi = (client: Pick<RuntimeClient, 'createSession' | 'createRun' | 'streamEvents' | 'getRun' | 'resolveApproval'>): EvalRunApi => {
  async function* events(runId: string): AsyncGenerator<PublicRunEvent> {
    for await (const frame of client.streamEvents(runId)) yield frame.data;
  }
  return {
    createSession: async (input) => ({ id: (await client.createSession({ cwd: input.cwd, env: input.env, permissionMode: input.permissionMode })).session.id }),
    createRun: async (sessionId, input) => ({
      id: (await client.createRun(sessionId, input.input, input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs })).run.id,
    }),
    events,
    getRun: async (runId) => {
      const run = await client.getRun(runId);
      return { id: run.id, status: run.status, ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }), step: run.step, usage: run.usage };
    },
    resolveApproval: async (approvalId, optionId) => {
      await client.resolveApproval(approvalId, optionId);
    },
  };
};
