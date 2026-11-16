import { isOpaqueEvent } from '@momonga/protocol';
import type { PublicRunEvent } from '@momonga/protocol';
import type { EvalRunApi } from '@momonga/eval';
import { recordedCostsOf } from './recorded-costs.ts';
import { ReconnectBoundExceeded, followEvents, isTerminalStatus } from '../run/follow.ts';
import type { ReconnectPolicy } from '../run/follow.ts';
import type { RunEventFrame, RuntimeClient } from './runtime-client.ts';

export type EventFollow = Pick<ReconnectPolicy, 'clock' | 'random' | 'reconnectBoundMs' | 'restoreConnection'>;

type Ended = { failed: false } | { failed: true; error: unknown };

export async function* followedRunEvents(client: Pick<RuntimeClient, 'streamEvents' | 'getRun'>, runId: string, follow: EventFollow): AsyncGenerator<PublicRunEvent> {
  const stop = new AbortController();
  const queue: RunEventFrame[] = [];
  let ended: Ended | undefined;
  let wake: (() => void) | undefined;
  const woken = (): void => {
    const waiting = wake;
    wake = undefined;
    waiting?.();
  };
  const following = followEvents<true>({
    ...follow,
    boundExceeded: (boundMs, cause) => new ReconnectBoundExceeded(runId, boundMs, cause),
    signal: stop.signal,
    open: (options) => client.streamEvents(runId, options),
    finished: async () => (isTerminalStatus((await client.getRun(runId)).status) ? true : undefined),
    onEvent: (frame) => {
      queue.push(frame);
      woken();
    },
    onDaemonStopping: () => undefined,
  }).then(
    () => {
      ended = { failed: false };
      woken();
    },
    (error: unknown) => {
      ended = { failed: true, error };
      woken();
    },
  );
  try {
    for (;;) {
      for (let frame = queue.shift(); frame !== undefined; frame = queue.shift()) {
        if (!isOpaqueEvent(frame.data)) yield frame.data;
      }
      if (ended !== undefined) {
        if (ended.failed) throw ended.error;
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    stop.abort();
    await following;
  }
}

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
  client: Pick<RuntimeClient, 'createSession' | 'createRun' | 'streamEvents' | 'getRun' | 'runReflection' | 'runAnsweredBy' | 'reportCost' | 'resolveApproval' | 'cancel'>,
  sessionEnv: Readonly<Record<string, string>> | undefined,
  settle: ReflectionSettle,
  follow: EventFollow,
): EvalRunApi => {
  const events = (runId: string): AsyncGenerator<PublicRunEvent> => followedRunEvents(client, runId, follow);
  const pinnedModels = new Map<string, string>();
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
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.mcpServers === undefined ? {} : { mcpServers: input.mcpServers }),
      });
      pinnedModels.set(session.id, session.model);
      return { id: session.id };
    },
    createRun: async (sessionId, input) => ({
      id: (
        await client.createRun(sessionId, input.input, {
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
          ...(input.limits === undefined ? {} : { limits: input.limits }),
          ...(input.mandate === undefined ? {} : { mandate: input.mandate }),
        })
      ).run.id,
    }),
    events,
    answeredBy: async (runId) => (await client.runAnsweredBy(runId)).answeredBy,
    costs: (runIds) => recordedCostsOf(client, runIds),
    getRun: async (runId) => {
      const run = await client.getRun(runId);
      const model = pinnedModels.get(run.sessionId);
      return {
        id: run.id,
        status: run.status,
        ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
        step: run.step,
        usage: run.usage,
        origin: run.origin,
        ...(model === undefined ? {} : { model }),
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
