import type { PublicRunEvent } from '@momonga/protocol';
import type { EvalRunApi } from '@momonga/eval';
import type { RuntimeClient } from './runtime-client.ts';

export type ReflectionSettle = { boundMs: number; pollMs: number; wait(ms: number): Promise<void> };

export const goldenRunApi = (
  client: Pick<RuntimeClient, 'createSession' | 'createRun' | 'streamEvents' | 'getRun' | 'runReflection' | 'resolveApproval' | 'cancel'>,
  sessionEnv: Readonly<Record<string, string>> | undefined,
  settle: ReflectionSettle,
): EvalRunApi => {
  async function* events(runId: string): AsyncGenerator<PublicRunEvent> {
    for await (const frame of client.streamEvents(runId)) yield frame.data;
  }
  const pinnedAliases = new Map<string, string>();
  const envOf = (given: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> => {
    const env = given ?? sessionEnv;
    if (env === undefined) throw new Error('a session needs an environment: the caller gave none and the run API was created without one');
    return env;
  };
  return {
    createSession: async (input) => {
      const { session } = await client.createSession({
        cwd: input.cwd,
        env: envOf(input.env),
        permissionMode: input.permissionMode,
        ...(input.modelAlias === undefined ? {} : { modelAlias: input.modelAlias }),
      });
      pinnedAliases.set(session.id, session.modelAlias);
      return { id: session.id };
    },
    createRun: async (sessionId, input) => ({
      id: (await client.createRun(sessionId, input.input, input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs })).run.id,
    }),
    events,
    getRun: async (runId) => {
      const run = await client.getRun(runId);
      const modelAlias = pinnedAliases.get(run.sessionId);
      return {
        id: run.id,
        status: run.status,
        ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
        step: run.step,
        usage: run.usage,
        origin: run.origin,
        ...(modelAlias === undefined ? {} : { modelAlias }),
      };
    },
    reflectionOf: async (runId) => {
      let waited = 0;
      for (;;) {
        const { job, charges } = await client.runReflection(runId);
        const state = job === null ? 'none' : job.state;
        const answer = { state, ...(charges.length === 0 ? {} : { charges }) } as const;
        if (state !== 'pending' && state !== 'running') return answer;
        if (waited >= settle.boundMs) return { ...answer, reason: `the reflection job was still ${state} after ${settle.boundMs} ms, the bound of its attempts` };
        await settle.wait(settle.pollMs);
        waited += settle.pollMs;
      }
    },
    resolveApproval: async (approvalId, optionId) => {
      await client.resolveApproval(approvalId, optionId);
    },
    cancelRun: async (runId) => {
      await client.cancel(runId);
    },
  };
};
