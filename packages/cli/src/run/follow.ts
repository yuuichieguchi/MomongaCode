import { computeBackoff } from '@momonga/foundation';
import { TERMINAL_STATUSES } from '@momonga/protocol';
import type { RunStatus } from '@momonga/protocol';
import { RECONNECT_FIRST_RETRY_MS, RECONNECT_MAX_INTERVAL_MS } from '../constants.ts';
import type { RunEventFrame, RuntimeClient } from '../client/runtime-client.ts';
import type { RunView } from '../client/views.ts';
import type { CliClock } from '../ports.ts';

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

export type StreamOpener = (options: { lastEventId?: number; signal?: AbortSignal }) => AsyncIterable<RunEventFrame>;

export type FollowEventsOptions<Result> = {
  clock: CliClock;
  random: () => number;
  after?: number;
  reconnectBoundMs: number;
  open: StreamOpener;
  finished(): Promise<Result | undefined>;
  boundExceeded(boundMs: number, cause: unknown): Error;
  restoreConnection(): Promise<void>;
  onEvent(frame: RunEventFrame): void;
  onReconnecting?(attempt: number): void;
  signal?: AbortSignal;
};

export const followEvents = async <Result>(options: FollowEventsOptions<Result>): Promise<Result> => {
  const { clock } = options;
  let cursor = options.after ?? 0;
  let attempt = 0;
  let stalledSince: number | undefined;
  for (;;) {
    let failure: unknown;
    try {
      const streamOptions = {
        ...(cursor > 0 ? { lastEventId: cursor } : {}),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      };
      for await (const frame of options.open(streamOptions)) {
        cursor = frame.id;
        attempt = 0;
        stalledSince = undefined;
        options.onEvent(frame);
      }
      const result = await options.finished();
      if (result !== undefined) return result;
    } catch (error) {
      if (options.signal?.aborted === true || !isTransientStreamError(error)) throw error;
      failure = error;
    }
    stalledSince ??= clock.now();
    if (clock.now() - stalledSince >= options.reconnectBoundMs) throw options.boundExceeded(options.reconnectBoundMs, failure);
    options.onReconnecting?.(attempt);
    await clock.sleep(
      computeBackoff({ attempt, baseMs: RECONNECT_FIRST_RETRY_MS, maxMs: RECONNECT_MAX_INTERVAL_MS, random: options.random }),
      options.signal,
    );
    attempt += 1;
    await options.restoreConnection();
  }
};

export type FollowOptions = {
  client: RuntimeClient;
  clock: CliClock;
  random: () => number;
  runId: string;
  after?: number;
  reconnectBoundMs: number;
  restoreConnection(): Promise<void>;
  onEvent(frame: RunEventFrame): void;
  onReconnecting?(attempt: number): void;
  signal?: AbortSignal;
};

export const followRun = (options: FollowOptions): Promise<RunView> => {
  const { client, runId } = options;
  return followEvents<RunView>({
    clock: options.clock,
    random: options.random,
    ...(options.after === undefined ? {} : { after: options.after }),
    reconnectBoundMs: options.reconnectBoundMs,
    open: (streamOptions) => client.streamEvents(runId, streamOptions),
    finished: async () => {
      const run = await client.getRun(runId);
      return isTerminalStatus(run.status) ? run : undefined;
    },
    boundExceeded: (boundMs, cause) => new ReconnectBoundExceeded(runId, boundMs, cause),
    restoreConnection: options.restoreConnection,
    onEvent: options.onEvent,
    ...(options.onReconnecting === undefined ? {} : { onReconnecting: options.onReconnecting }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
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
  restoreConnection(): Promise<void>;
  onEvent(frame: RunEventFrame): void;
  onReconnecting?(attempt: number): void;
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
    signal: options.signal,
  });
};
