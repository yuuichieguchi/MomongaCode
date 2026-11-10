import type { PublicRunEvent } from '@momonga/protocol';
import type { EvalRunApi } from '@momonga/eval';
import { DaemonMoved } from './runtime-client.ts';
import type { RuntimeClient } from './runtime-client.ts';

export type ReflectionSettle = {
  pendingBoundMs: number;
  attemptBoundMs: number;
  pollMs: number;
  now(): number;
  wait(ms: number, signal?: AbortSignal): Promise<void>;
  signal?: AbortSignal;
};

const pause = async (settle: ReflectionSettle): Promise<void> => {
  const { signal } = settle;
  if (signal === undefined) return settle.wait(settle.pollMs);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([settle.wait(settle.pollMs, signal), aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
};

export const goldenRunApi = (
  client: Pick<RuntimeClient, 'createSession' | 'createRun' | 'streamEvents' | 'getRun' | 'runReflection' | 'runAnsweredBy' | 'resolveApproval' | 'cancel'>,
  sessionEnv: Readonly<Record<string, string>> | undefined,
  settle: ReflectionSettle,
): EvalRunApi => {
  async function* events(runId: string): AsyncGenerator<PublicRunEvent> {
    let cursor: number | undefined;
    for (;;) {
      try {
        for await (const frame of client.streamEvents(runId, cursor === undefined ? {} : { lastEventId: cursor })) {
          cursor = frame.id;
          yield frame.data;
        }
        return;
      } catch (error) {
        if (!(error instanceof DaemonMoved)) throw error;
      }
    }
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
    answeredBy: async (runId) => (await client.runAnsweredBy(runId)).answeredBy,
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
      let watchedAt = settle.now();
      let queueSeen = Number.POSITIVE_INFINITY;
      let attemptSeenAt: number | undefined;
      for (;;) {
        settle.signal?.throwIfAborted();
        const { job, charges, queuedAhead } = await client.runReflection(runId);
        if (queuedAhead < queueSeen) {
          if (queueSeen !== Number.POSITIVE_INFINITY) watchedAt = settle.now();
          queueSeen = queuedAhead;
        }
        const state = job === null ? 'none' : job.state;
        const answer = { state, ...(charges.length === 0 ? {} : { charges }) } as const;
        if (state !== 'pending' && state !== 'running') return answer;
        if (attemptSeenAt === undefined && job !== null && (job.state === 'running' || job.attempts > 0)) attemptSeenAt = settle.now();
        if (attemptSeenAt === undefined) {
          if (settle.now() - watchedAt >= settle.pendingBoundMs + queuedAhead * settle.attemptBoundMs) {
            return { ...answer, reason: 'the runtime was busy with other runs, so the reflection did not start' };
          }
        } else if (settle.now() - attemptSeenAt >= settle.attemptBoundMs) {
          return { ...answer, reason: `the reflection job was still ${state} after ${settle.attemptBoundMs} ms, the bound of its attempts` };
        }
        await pause(settle);
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
