import { describe, expect, it } from 'vitest';
import type { PublicRunEvent } from '@momonga/protocol';
import type { RunEventFrame, RuntimeClient } from '../src/client/runtime-client.ts';
import { ReconnectBoundExceeded, followRun, isTerminalStatus, isTransientStreamError } from '../src/run/follow.ts';
import { runView } from './fake-backend.ts';
import { virtualClock } from './fake-supervisor.ts';

const frame = (id: number): RunEventFrame => ({
  id,
  event: 'agent.message.delta',
  data: { type: 'agent.message.delta', id, runId: 'run-1', sessionId: 'session-1', seq: id, step: 1, createdAt: 1, attempt: 0, itemId: 'm', text: String(id) } as PublicRunEvent,
});

const errno = (code: string): Error => Object.assign(new Error(code), { code });

type Stream = { frames: number[]; thenThrow?: Error };

const clientOf = (streams: readonly Stream[], statuses: readonly ReturnType<typeof runView>[]): { client: RuntimeClient; opened: Array<number | undefined> } => {
  const opened: Array<number | undefined> = [];
  let next = 0;
  let polled = 0;
  const client = {
    streamEvents: async function* (_runId: string, options: { lastEventId?: number } = {}) {
      opened.push(options.lastEventId);
      const stream = streams[next];
      next += 1;
      if (stream === undefined) throw new Error('unexpected stream open');
      for (const id of stream.frames) yield frame(id);
      if (stream.thenThrow !== undefined) throw stream.thenThrow;
    },
    getRun: async () => {
      const run = statuses[polled];
      polled += 1;
      if (run === undefined) throw new Error('unexpected getRun');
      return run;
    },
  } as unknown as RuntimeClient;
  return { client, opened };
};

const options = (client: RuntimeClient, seen: number[], extra: Partial<Parameters<typeof followRun>[0]> = {}): Parameters<typeof followRun>[0] => ({
  client,
  clock: virtualClock(),
  random: () => 0.5,
  runId: 'run-1',
  reconnectBoundMs: 10_000,
  restoreConnection: async () => undefined,
  onEvent: (received) => seen.push(received.id),
  ...extra,
});

describe('followRun', () => {
  it('delivers every event of a finished stream and returns the terminal run', async () => {
    const seen: number[] = [];
    const { client, opened } = clientOf([{ frames: [1, 2, 3] }], [runView({ status: 'COMPLETED' })]);

    const run = await followRun(options(client, seen));

    expect(seen).toEqual([1, 2, 3]);
    expect(run.status).toBe('COMPLETED');
    expect(opened).toEqual([undefined]);
  });

  it('starts after the given cursor with Last-Event-ID', async () => {
    const { client, opened } = clientOf([{ frames: [] }], [runView()]);

    await followRun(options(client, [], { after: 7 }));

    expect(opened).toEqual([7]);
  });

  it('reconnects after a dropped connection from the last event it saw, without a gap or a duplicate', async () => {
    const seen: number[] = [];
    const restored: number[] = [];
    const { client, opened } = clientOf([{ frames: [1, 2], thenThrow: errno('UND_ERR_SOCKET') }, { frames: [3, 4] }], [runView({ status: 'COMPLETED' })]);

    await followRun(options(client, seen, { restoreConnection: async () => void restored.push(restored.length) }));

    expect(seen).toEqual([1, 2, 3, 4]);
    expect(opened).toEqual([undefined, 2]);
    expect(restored).toEqual([0]);
  });

  it('reconnects when the stream ends before the run is terminal', async () => {
    const seen: number[] = [];
    const { client, opened } = clientOf([{ frames: [1] }, { frames: [2] }], [runView({ status: 'RUNNING' }), runView({ status: 'COMPLETED' })]);

    await followRun(options(client, seen));

    expect(seen).toEqual([1, 2]);
    expect(opened).toEqual([undefined, 1]);
  });

  it('does not retry a failure that is not a lost connection', async () => {
    const { client } = clientOf([{ frames: [1], thenThrow: new Error('the server answered 400') }], []);

    await expect(followRun(options(client, []))).rejects.toThrow('the server answered 400');
  });

  it('gives up when the stream cannot be restored within the bound', async () => {
    const { client } = clientOf(Array.from({ length: 50 }, () => ({ frames: [], thenThrow: errno('ECONNREFUSED') })), []);

    await expect(followRun(options(client, [], { reconnectBoundMs: 2000 }))).rejects.toBeInstanceOf(ReconnectBoundExceeded);
  });

  it('does not reconnect once the caller aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { client } = clientOf([{ frames: [], thenThrow: errno('ECONNRESET') }], []);

    await expect(followRun(options(client, [], { signal: controller.signal }))).rejects.toThrow('ECONNRESET');
  });

  it('reports each reconnect attempt', async () => {
    const attempts: number[] = [];
    const { client } = clientOf([{ frames: [], thenThrow: errno('ECONNRESET') }, { frames: [], thenThrow: errno('ECONNRESET') }, { frames: [] }], [runView()]);

    await followRun(options(client, [], { onReconnecting: (attempt) => attempts.push(attempt) }));

    expect(attempts).toEqual([0, 1]);
  });
});

describe('classification', () => {
  it.each(['ECONNRESET', 'ECONNREFUSED', 'ENOENT', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED'])('%s is a lost connection', (code) => {
    expect(isTransientStreamError(errno(code))).toBe(true);
  });

  it.each([new Error('plain'), errno('EACCES'), 'text', undefined])('%s is not', (error) => {
    expect(isTransientStreamError(error)).toBe(false);
  });

  it('knows the terminal run states', () => {
    expect(['COMPLETED', 'STOPPED', 'FAILED', 'CANCELLED'].every((status) => isTerminalStatus(status as 'COMPLETED'))).toBe(true);
    expect(['QUEUED', 'RUNNING', 'WAITING_TOOL', 'WAITING_HUMAN', 'CANCELLING'].some((status) => isTerminalStatus(status as 'RUNNING'))).toBe(false);
  });
});
