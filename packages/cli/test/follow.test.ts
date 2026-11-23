import { describe, expect, it } from 'vitest';
import type { PublicRunEvent } from '@momonga/protocol';
import { DaemonMoved } from '../src/client/runtime-client.ts';
import type { RunEventFrame, RuntimeClient } from '../src/client/runtime-client.ts';
import { DaemonUnreachable, ReconnectBoundExceeded, SessionStreamLost, followRun, followSession, isTerminalStatus, isTransientStreamError, retryAfterRestore } from '../src/run/follow.ts';
import { runView } from './fake-backend.ts';
import { virtualClock } from './fake-supervisor.ts';

const frame = (id: number): RunEventFrame => ({
  id,
  event: 'agent.message.delta',
  data: { type: 'agent.message.delta', id, runId: 'run-1', sessionId: 'session-1', seq: id, step: 1, createdAt: 1, attempt: 0, itemId: 'm', text: String(id) } as PublicRunEvent,
});

const errno = (code: string): Error => Object.assign(new Error(code), { code });

type Stream = { frames: number[]; thenThrow?: Error; neverOpens?: true; idle?: () => void };

const clientOf = (streams: readonly Stream[], statuses: readonly ReturnType<typeof runView>[]): { client: RuntimeClient; opened: Array<number | undefined> } => {
  const opened: Array<number | undefined> = [];
  let next = 0;
  let polled = 0;
  const client = {
    streamEvents: async function* (_runId: string, options: { lastEventId?: number; onOpen?: () => void } = {}) {
      opened.push(options.lastEventId);
      const stream = streams[next];
      next += 1;
      if (stream === undefined) throw new Error('unexpected stream open');
      if (stream.neverOpens !== true) options.onOpen?.();
      for (const id of stream.frames) yield frame(id);
      stream.idle?.();
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
  onDaemonStopping: () => undefined,
  clock: virtualClock(),
  random: () => 0.5,
  runId: 'run-1',
  reconnectBoundMs: 10_000,
  restoreConnection: async () => undefined,
  onEvent: (received) => seen.push(received.id),
  ...extra,
});

describe('followRun', () => {
  it('treats the daemon.current frame as a planned move: it restores the connection and resumes from the last event with no backoff sleep and no reconnect notice (20.44)', async () => {
    const seen: number[] = [];
    const attempts: number[] = [];
    const restored: number[] = [];
    const clock = virtualClock();
    const { client, opened } = clientOf([{ frames: [1, 2], thenThrow: new DaemonMoved(2, '1.2.4') }, { frames: [3] }], [runView({ status: 'COMPLETED' })]);

    const run = await followRun(
      options(client, seen, {
        clock,
        restoreConnection: async () => void restored.push(clock.now()),
        onReconnecting: (attempt) => attempts.push(attempt),
      }),
    );

    expect(run.status).toBe('COMPLETED');
    expect(seen).toEqual([1, 2, 3]);
    expect(opened).toEqual([undefined, 2]);
    expect(attempts).toEqual([]);
    expect(restored).toEqual([0]);
    expect(clock.now()).toBe(0);
  });

  it('delivers every event of a finished stream and returns the terminal run', async () => {
    const seen: number[] = [];
    const { client, opened } = clientOf([{ frames: [1, 2, 3] }], [runView({ status: 'COMPLETED' })]);

    const run = await followRun(options(client, seen));

    expect(seen).toEqual([1, 2, 3]);
    expect(run.status).toBe('COMPLETED');
    expect(opened).toEqual([undefined]);
  });

  it('hands the events up to the seen cursor to the seen handler and the rest to the event handler', async () => {
    const seen: number[] = [];
    const replayed: number[] = [];
    const { client, opened } = clientOf([{ frames: [1, 2, 3, 4] }], [runView()]);

    await followRun(options(client, seen, { seenThrough: 2, onSeenEvent: (received) => replayed.push(received.id) }));

    expect(replayed).toEqual([1, 2]);
    expect(seen).toEqual([3, 4]);
    expect(opened).toEqual([undefined]);
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

  it('hands the caller signal to the connection restore, so that an interrupt can stop a restore in progress', async () => {
    const seen: number[] = [];
    const received: Array<AbortSignal | undefined> = [];
    const { client } = clientOf([{ frames: [1], thenThrow: errno('ECONNRESET') }, { frames: [2] }], [runView({ status: 'COMPLETED' })]);
    const controller = new AbortController();

    await followRun(options(client, seen, { signal: controller.signal, restoreConnection: async (signal) => void received.push(signal) }));

    expect(received).toHaveLength(1);
    expect(received[0]?.aborted).toBe(false);
    controller.abort();
    expect(received[0]?.aborted).toBe(true);
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

  it('measures a second outage from its own start when the first reconnect delivered no event', async () => {
    const clock = virtualClock();
    const { client, opened } = clientOf(
      [
        { frames: [1], thenThrow: errno('ECONNRESET') },
        { frames: [], thenThrow: errno('ECONNRESET'), idle: () => void clock.sleep(20_000) },
        { frames: [2] },
      ],
      [runView({ status: 'COMPLETED' })],
    );

    const run = await followRun(options(client, [], { clock, reconnectBoundMs: 10_000 }));

    expect(run.status).toBe('COMPLETED');
    expect(opened).toEqual([undefined, 1, 1]);
  });

  it('gives up on a stream that answers and then breaks before its first event every time, instead of reconnecting for ever', async () => {
    const { client } = clientOf(Array.from({ length: 50 }, () => ({ frames: [], thenThrow: errno('UND_ERR_SOCKET') })), []);

    await expect(followRun(options(client, [], { reconnectBoundMs: 2000 }))).rejects.toBeInstanceOf(ReconnectBoundExceeded);
  });

  it('starts the outage again after an event was delivered', async () => {
    const clock = virtualClock();
    const { client } = clientOf(
      [
        { frames: [1], thenThrow: errno('ECONNRESET'), idle: () => void clock.sleep(8_000) },
        { frames: [2], thenThrow: errno('ECONNRESET'), idle: () => void clock.sleep(8_000) },
        { frames: [3] },
      ],
      [runView({ status: 'COMPLETED' })],
    );

    expect((await followRun(options(client, [], { clock, reconnectBoundMs: 10_000 }))).status).toBe('COMPLETED');
  });

  it('gives up when the stream cannot be restored within the bound', async () => {
    const { client } = clientOf(Array.from({ length: 50 }, () => ({ frames: [], thenThrow: errno('ECONNREFUSED'), neverOpens: true as const })), []);

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

describe('followSession', () => {
  const sessionClientOf = (streams: readonly Stream[]): { client: RuntimeClient; opened: Array<number | undefined> } => {
    const opened: Array<number | undefined> = [];
    let next = 0;
    const client = {
      streamSessionEvents: async function* (_sessionId: string, streamOptions: { lastEventId?: number; onOpen?: () => void } = {}) {
        opened.push(streamOptions.lastEventId);
        const stream = streams[next];
        next += 1;
        if (stream === undefined) throw new Error('unexpected stream open');
        if (stream.neverOpens !== true) streamOptions.onOpen?.();
        for (const id of stream.frames) yield frame(id);
        if (stream.thenThrow !== undefined) throw stream.thenThrow;
      },
    } as unknown as RuntimeClient;
    return { client, opened };
  };

  const sessionOptions = (client: RuntimeClient, seen: number[], extra: Partial<Parameters<typeof followSession>[0]> = {}): Parameters<typeof followSession>[0] => ({
    client,
    onDaemonStopping: () => undefined,
    clock: virtualClock(),
    random: () => 0.5,
    sessionId: 'session-1',
    after: 7,
    reconnectBoundMs: 10_000,
    restoreConnection: async () => undefined,
    onEvent: (received) => seen.push(received.id),
    signal: new AbortController().signal,
    ...extra,
  });

  it('starts after the event id it was given and reconnects from the last event it saw', async () => {
    const seen: number[] = [];
    const { client, opened } = sessionClientOf([{ frames: [8, 9], thenThrow: errno('UND_ERR_SOCKET') }, { frames: [10], thenThrow: new Error('stop here') }]);

    await expect(followSession(sessionOptions(client, seen))).rejects.toThrow('stop here');

    expect(seen).toEqual([8, 9, 10]);
    expect(opened).toEqual([7, 9]);
  });

  it('opens a stream from the very beginning when it is told to start after nothing', async () => {
    const { client, opened } = sessionClientOf([{ frames: [], thenThrow: new Error('stop here') }]);

    await expect(followSession(sessionOptions(client, [], { after: 0 }))).rejects.toThrow('stop here');

    expect(opened).toEqual([undefined]);
  });

  it('reconnects when the server ends the stream, because a session has no end', async () => {
    const seen: number[] = [];
    const { client, opened } = sessionClientOf([{ frames: [8] }, { frames: [9], thenThrow: new Error('stop here') }]);

    await expect(followSession(sessionOptions(client, seen))).rejects.toThrow('stop here');

    expect(seen).toEqual([8, 9]);
    expect(opened).toEqual([7, 8]);
  });

  it('stops with the failure of the stream once the caller aborted', async () => {
    const controller = new AbortController();
    const seen: number[] = [];
    const { client } = sessionClientOf([{ frames: [8], thenThrow: errno('ECONNRESET') }]);

    await expect(followSession(sessionOptions(client, seen, { signal: controller.signal, onEvent: () => controller.abort() }))).rejects.toThrow('ECONNRESET');
  });

  it('tells the caller each time the session stream is connected: at the start and at every reconnect, before the events of that connection', async () => {
    const order: string[] = [];
    const { client } = sessionClientOf([{ frames: [8], thenThrow: errno('ECONNRESET') }, { frames: [9] }, { frames: [10], thenThrow: new Error('stop here') }]);

    await expect(
      followSession(sessionOptions(client, [], { onOpen: () => order.push('open'), onEvent: (received) => order.push(`event ${received.id}`) } as Partial<Parameters<typeof followSession>[0]>)),
    ).rejects.toThrow('stop here');

    expect(order).toEqual(['open', 'event 8', 'open', 'event 9', 'open', 'event 10']);
  });

  it('does not tell the caller of a connection that never opened', async () => {
    const opens: number[] = [];
    const { client } = sessionClientOf([{ frames: [], thenThrow: errno('ECONNREFUSED'), neverOpens: true }, { frames: [8], thenThrow: new Error('stop here') }]);

    await expect(followSession(sessionOptions(client, [], { onOpen: () => opens.push(opens.length) } as Partial<Parameters<typeof followSession>[0]>))).rejects.toThrow('stop here');

    expect(opens).toEqual([0]);
  });

  it('gives up when the stream cannot be restored within the bound', async () => {
    const { client } = sessionClientOf(Array.from({ length: 50 }, () => ({ frames: [], thenThrow: errno('ECONNREFUSED'), neverOpens: true as const })));

    const failure = await followSession(sessionOptions(client, [], { reconnectBoundMs: 2000 })).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SessionStreamLost);
    expect(failure).toMatchObject({ sessionId: 'session-1', boundMs: 2000 });
  });
});

describe('retryAfterRestore', () => {
  const policyOf = (restored: number[], extra: Partial<Parameters<typeof retryAfterRestore>[0]> = {}): Parameters<typeof retryAfterRestore>[0] => ({
    clock: virtualClock(),
    random: () => 0.5,
    reconnectBoundMs: 10_000,
    boundExceeded: (boundMs, cause) => new DaemonUnreachable(boundMs, cause),
    restoreConnection: async () => void restored.push(restored.length),
    ...extra,
  });

  it('runs the operation again after restoring the connection when it failed with a lost connection', async () => {
    const restored: number[] = [];
    let calls = 0;

    const value = await retryAfterRestore(policyOf(restored), async () => {
      calls += 1;
      if (calls === 1) throw errno('ECONNRESET');
      return 'done';
    });

    expect(value).toBe('done');
    expect(restored).toEqual([0]);
  });

  it('does not retry a failure that is not a lost connection', async () => {
    const restored: number[] = [];

    await expect(
      retryAfterRestore(policyOf(restored), async () => {
        throw new Error('the server answered 400');
      }),
    ).rejects.toThrow('the server answered 400');
    expect(restored).toEqual([]);
  });

  it('gives up with a typed error once the connection stayed lost for the bound', async () => {
    const failure = await retryAfterRestore(policyOf([], { reconnectBoundMs: 2000 }), async () => {
      throw errno('ECONNREFUSED');
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DaemonUnreachable);
    expect(failure).toMatchObject({ boundMs: 2000 });
  });

  it('does not retry once the caller aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      retryAfterRestore(policyOf([], { signal: controller.signal }), async () => {
        throw errno('ECONNRESET');
      }),
    ).rejects.toThrow('ECONNRESET');
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
