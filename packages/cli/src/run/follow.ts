import { computeBackoff } from '@momonga/foundation';
import { TERMINAL_STATUSES, isOpaqueEvent } from '@momonga/protocol';
import type { RunStatus } from '@momonga/protocol';
import { RECONNECT_FIRST_RETRY_MS, RECONNECT_MAX_INTERVAL_MS } from '../constants.ts';
import { DaemonMoved } from '../client/runtime-client.ts';
import type { RunEventFrame, RuntimeClient } from '../client/runtime-client.ts';
import type { RunView } from '../client/views.ts';
import type { CliClock } from '../ports.ts';

export const DAEMON_STOPPING_TEXT = 'The daemon is stopping. A run it interrupts goes on when the daemon starts again.';

export const isTerminalStatus = (status: RunStatus): boolean => (TERMINAL_STATUSES as readonly RunStatus[]).includes(status);

const TRANSIENT_STREAM_CODES: ReadonlySet<string> = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOENT', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']);

const codeOf = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
};

export const isTransientStreamError = (error: unknown): boolean => {
  const code = codeOf(error);
  return code !== undefined && TRANSIENT_STREAM_CODES.has(code);
};

export class ReconnectBoundExceeded extends Error {
  readonly runId: string;
  readonly boundMs: number;

  constructor(runId: string, boundMs: number, cause: unknown) {
    super(`lost the event stream of run ${runId} and could not reconnect within ${boundMs} ms`, { cause });
    this.name = 'ReconnectBoundExceeded';
    this.runId = runId;
    this.boundMs = boundMs;
  }
}

export type StreamOpener = (options: { lastEventId?: number; signal?: AbortSignal; onOpen?: () => void; onDaemonStopping?: () => void }) => AsyncIterable<RunEventFrame>;

export type ReconnectPolicy = {
  clock: CliClock;
  random: () => number;
  reconnectBoundMs: number;
  boundExceeded(boundMs: number, cause: unknown): Error;
  restoreConnection(signal: AbortSignal | undefined): Promise<void>;
  onReconnecting?(attempt: number): void;
  signal?: AbortSignal;
};

type Reconnector = { opened(): void; delivered(): void; reconnect(failure: unknown): Promise<void> };

const createReconnector = (policy: ReconnectPolicy): Reconnector => {
  let attempt = 0;
  let lostMs = 0;
  let lostSince: number | undefined;
  return {
    opened: () => {
      if (lostSince === undefined) return;
      lostMs += policy.clock.now() - lostSince;
      lostSince = undefined;
    },
    delivered: () => {
      attempt = 0;
      lostMs = 0;
      lostSince = undefined;
    },
    reconnect: async (failure) => {
      lostSince ??= policy.clock.now();
      if (lostMs + policy.clock.now() - lostSince >= policy.reconnectBoundMs) throw policy.boundExceeded(policy.reconnectBoundMs, failure);
      policy.onReconnecting?.(attempt);
      await policy.clock.sleep(
        computeBackoff({ attempt, baseMs: RECONNECT_FIRST_RETRY_MS, maxMs: RECONNECT_MAX_INTERVAL_MS, random: { float: policy.random } }),
        policy.signal,
      );
      attempt += 1;
      await policy.restoreConnection(policy.signal);
    },
  };
};

export const retryAfterRestore = async <T>(policy: ReconnectPolicy, operation: () => Promise<T>): Promise<T> => {
  const reconnector = createReconnector(policy);
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (policy.signal?.aborted === true || !isTransientStreamError(error)) throw error;
      await reconnector.reconnect(error);
    }
  }
};

export class DaemonUnreachable extends Error {
  readonly boundMs: number;

  constructor(boundMs: number, cause: unknown) {
    super(`lost the connection to the daemon and could not restore it within ${boundMs} ms`, { cause });
    this.name = 'DaemonUnreachable';
    this.boundMs = boundMs;
  }
}

export type FollowEventsOptions<Result> = ReconnectPolicy & {
  after?: number;
  open: StreamOpener;
  finished(): Promise<Result | undefined>;
  onEvent(frame: RunEventFrame): void;
  onDaemonStopping(): void;
};

export const followEvents = async <Result>(options: FollowEventsOptions<Result>): Promise<Result> => {
  const reconnector = createReconnector(options);
  let cursor = options.after ?? 0;
  for (;;) {
    let failure: unknown;
    try {
      const streamOptions = {
        ...(cursor > 0 ? { lastEventId: cursor } : {}),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        onOpen: reconnector.opened,
        onDaemonStopping: options.onDaemonStopping,
      };
      for await (const frame of options.open(streamOptions)) {
        cursor = frame.id;
        reconnector.delivered();
        options.onEvent(frame);
      }
      const result = await options.finished();
      if (result !== undefined) return result;
    } catch (error) {
      if (options.signal?.aborted !== true && error instanceof DaemonMoved) {
        await options.restoreConnection(options.signal);
        continue;
      }
      if (options.signal?.aborted === true || !isTransientStreamError(error)) throw error;
      failure = error;
    }
    await reconnector.reconnect(failure);
  }
};

export type ChildFrameHandler = (frame: RunEventFrame, agent: string) => void;

export type ChildStartHandler = (agent: string, runId: string, backlog: number) => void;

export type ChildEnd = { readonly kind: 'finished'; readonly run: RunView } | { readonly kind: 'failed'; readonly error: unknown };

export type ChildEndHandler = (agent: string, runId: string, end: ChildEnd) => void;

export type FollowOptions = {
  client: RuntimeClient;
  clock: CliClock;
  random: () => number;
  runId: string;
  seenThrough?: number;
  reconnectBoundMs: number;
  restoreConnection(signal: AbortSignal | undefined): Promise<void>;
  onSeenEvent?(frame: RunEventFrame): void;
  onEvent(frame: RunEventFrame): void;
  onChildEvent?: ChildFrameHandler;
  onChildStarted?: ChildStartHandler;
  onChildEnded?: ChildEndHandler;
  onReconnecting?(attempt: number): void;
  onDaemonStopping(): void;
  signal?: AbortSignal;
};

type Failure = { error: unknown };

export const followRun = async (options: FollowOptions): Promise<RunView> => {
  const { client, runId, onChildEvent } = options;
  const stop = new AbortController();
  const signal = options.signal === undefined ? stop.signal : AbortSignal.any([stop.signal, options.signal]);
  const followed = new Set<string>();
  const children: Promise<void>[] = [];
  let childFailure: Failure | undefined;

  let told = false;
  const stopping = (): void => {
    if (told) return;
    told = true;
    options.onDaemonStopping();
  };

  const followChild = (childRunId: string, agent: string, handler: ChildFrameHandler): void => {
    if (followed.has(childRunId)) return;
    followed.add(childRunId);
    let started = false;
    const opened = async (): Promise<RunView> => {
      const { lastSeq } = await client.getRun(childRunId);
      started = true;
      options.onChildStarted?.(agent, childRunId, lastSeq);
      return followRun({
        client,
        clock: options.clock,
        random: options.random,
        runId: childRunId,
        reconnectBoundMs: options.reconnectBoundMs,
        restoreConnection: options.restoreConnection,
        onEvent: (frame) => handler(frame, agent),
        onChildEvent: handler,
        ...(options.onChildStarted === undefined ? {} : { onChildStarted: options.onChildStarted }),
        ...(options.onChildEnded === undefined ? {} : { onChildEnded: options.onChildEnded }),
        ...(options.onReconnecting === undefined ? {} : { onReconnecting: options.onReconnecting }),
        onDaemonStopping: stopping,
        signal,
      });
    };
    children.push(
      opened().then(
        (run) => {
          options.onChildEnded?.(agent, childRunId, { kind: 'finished', run });
        },
        (error: unknown) => {
          childFailure ??= { error };
          stop.abort();
          if (started) options.onChildEnded?.(agent, childRunId, { kind: 'failed', error });
        },
      ),
    );
  };

  const seenThrough = options.seenThrough ?? 0;

  const onEvent = (frame: RunEventFrame): void => {
    if (frame.id <= seenThrough) {
      options.onSeenEvent?.(frame);
      return;
    }
    options.onEvent(frame);
    const event = frame.data;
    if (isOpaqueEvent(event)) return;
    if (onChildEvent !== undefined && event.type === 'tool.waiting' && event.awaits.kind === 'run') followChild(event.awaits.runId, event.awaits.agent, onChildEvent);
  };

  let run: RunView;
  try {
    if (onChildEvent !== undefined && seenThrough > 0) {
      for (const child of await client.childRuns(runId)) {
        if (isTerminalStatus(child.status)) continue;
        if (child.agent === undefined) throw new Error(`child run ${child.id} of run ${runId} names no agent`);
        followChild(child.id, child.agent, onChildEvent);
      }
    }
    run = await followEvents<RunView>({
      clock: options.clock,
      random: options.random,
      reconnectBoundMs: options.reconnectBoundMs,
      open: (streamOptions) => client.streamEvents(runId, streamOptions),
      finished: async () => {
        const current = await client.getRun(runId);
        return isTerminalStatus(current.status) ? current : undefined;
      },
      boundExceeded: (boundMs, cause) => new ReconnectBoundExceeded(runId, boundMs, cause),
      restoreConnection: options.restoreConnection,
      onEvent,
      ...(options.onReconnecting === undefined ? {} : { onReconnecting: options.onReconnecting }),
      onDaemonStopping: stopping,
      signal,
    });
  } catch (error) {
    stop.abort();
    await Promise.all(children);
    throw options.signal?.aborted === true || childFailure === undefined ? error : childFailure.error;
  }
  await Promise.all(children);
  if (childFailure !== undefined) throw childFailure.error;
  return run;
};

export class SessionStreamLost extends Error {
  readonly sessionId: string;
  readonly boundMs: number;

  constructor(sessionId: string, boundMs: number, cause: unknown) {
    super(`lost the event stream of session ${sessionId} and could not reconnect within ${boundMs} ms`, { cause });
    this.name = 'SessionStreamLost';
    this.sessionId = sessionId;
    this.boundMs = boundMs;
  }
}

export type FollowSessionOptions = {
  client: RuntimeClient;
  clock: CliClock;
  random: () => number;
  sessionId: string;
  after: number;
  reconnectBoundMs: number;
  restoreConnection(signal: AbortSignal | undefined): Promise<void>;
  onEvent(frame: RunEventFrame): void;
  onReconnecting?(attempt: number): void;
  onDaemonStopping(): void;
  signal: AbortSignal;
};

export const followSession = (options: FollowSessionOptions): Promise<never> => {
  const { client, sessionId } = options;
  return followEvents<never>({
    clock: options.clock,
    random: options.random,
    after: options.after,
    reconnectBoundMs: options.reconnectBoundMs,
    open: (streamOptions) => client.streamSessionEvents(sessionId, streamOptions),
    finished: async () => undefined,
    boundExceeded: (boundMs, cause) => new SessionStreamLost(sessionId, boundMs, cause),
    restoreConnection: options.restoreConnection,
    onEvent: options.onEvent,
    ...(options.onReconnecting === undefined ? {} : { onReconnecting: options.onReconnecting }),
    onDaemonStopping: options.onDaemonStopping,
    signal: options.signal,
  });
};
