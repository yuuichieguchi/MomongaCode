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

export const followRun = async (options: FollowOptions): Promise<RunView> => {
  const { client, clock, runId } = options;
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
      for await (const frame of client.streamEvents(runId, streamOptions)) {
        cursor = frame.id;
        attempt = 0;
        stalledSince = undefined;
        options.onEvent(frame);
      }
      const run = await client.getRun(runId);
      if (isTerminalStatus(run.status)) return run;
    } catch (error) {
      if (options.signal?.aborted === true || !isTransientStreamError(error)) throw error;
      failure = error;
    }
    stalledSince ??= clock.now();
    if (clock.now() - stalledSince >= options.reconnectBoundMs) throw new ReconnectBoundExceeded(runId, options.reconnectBoundMs, failure);
    options.onReconnecting?.(attempt);
    await clock.sleep(
      computeBackoff({ attempt, baseMs: RECONNECT_FIRST_RETRY_MS, maxMs: RECONNECT_MAX_INTERVAL_MS, random: options.random }),
      options.signal,
    );
    attempt += 1;
    await options.restoreConnection();
  }
};
