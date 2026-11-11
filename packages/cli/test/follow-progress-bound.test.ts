import http from 'node:http';
import path from 'node:path';
import { fixedSocket } from '@momonga/foundation';
import { STREAM_FAILED_EVENT } from '@momonga/protocol';
import type { PublicRunEvent } from '@momonga/protocol';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';
import { ContractViolation } from '../src/client/contract.ts';
import { StreamFailed, createRuntimeClient } from '../src/client/runtime-client.ts';
import type { RunEventFrame, RuntimeClient } from '../src/client/runtime-client.ts';
import { nodeClock } from '../src/node-ports.ts';
import { ReconnectBoundExceeded, followRun, isTransientStreamError } from '../src/run/follow.ts';
import { runView } from './fake-backend.ts';
import { virtualClock } from './fake-supervisor.ts';

const FAKE_PERSON_CAPABILITY = 'f'.repeat(32);

const frame = (id: number): RunEventFrame => ({
  id,
  event: 'agent.message.delta',
  data: { type: 'agent.message.delta', id, runId: 'run-1', sessionId: 'session-1', seq: id, step: 1, createdAt: 1, attempt: 0, itemId: 'm', text: String(id) } as PublicRunEvent,
});

const socketClosed = (): Error => Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });

type Attempt = { frames?: number[]; openFor?: number; breaks?: Error };

const BOUND_MS = 10_000;

const scripted = (clock: ReturnType<typeof virtualClock>, attemptOf: (index: number) => Attempt, statuses: ReturnType<typeof runView>[] = []): { client: RuntimeClient; opened: number[] } => {
  const opened: number[] = [];
  let polled = 0;
  const client = {
    streamEvents: async function* (_runId: string, options: { onOpen?: () => void } = {}) {
      const attempt = attemptOf(opened.length);
      opened.push(clock.now());
      options.onOpen?.();
      for (const id of attempt.frames ?? []) yield frame(id);
      if (attempt.openFor !== undefined) await clock.sleep(attempt.openFor);
      if (attempt.breaks !== undefined) throw attempt.breaks;
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

const follow = (client: RuntimeClient, clock: ReturnType<typeof virtualClock>, seen: number[] = []) =>
  followRun({ client, clock, random: () => 0.5, runId: 'run-1', reconnectBoundMs: BOUND_MS, restoreConnection: async () => undefined, onEvent: (received) => seen.push(received.id) });

describe('the bound of a follow counts the time without the stream since the last event', () => {
  it('ends a stream that opens and breaks before any frame, every time, with ReconnectBoundExceeded and the cause', async () => {
    const clock = virtualClock();
    const failure = socketClosed();
    const { client, opened } = scripted(clock, () => ({ breaks: failure }));

    const outcome = await follow(client, clock).catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(ReconnectBoundExceeded);
    expect(outcome).toMatchObject({ runId: 'run-1', boundMs: BOUND_MS, cause: failure });
    expect(opened.length).toBeGreaterThan(1);
    expect(opened.at(-2)).toBeLessThan(BOUND_MS);
    expect(opened.at(-1)).toBeLessThan(BOUND_MS * 2);
  });

  it('does not count the time a stream stayed open with nothing to deliver', async () => {
    const clock = virtualClock();
    const { client, opened } = scripted(clock, (index) => (index < 4 ? { openFor: BOUND_MS * 3, breaks: socketClosed() } : {}), [runView({ status: 'COMPLETED' })]);

    const run = await follow(client, clock);

    expect(run.status).toBe('COMPLETED');
    expect(opened).toHaveLength(5);
    expect(clock.now()).toBeGreaterThan(BOUND_MS * 12);
  });

  it('starts the count again when an event was delivered', async () => {
    const clock = virtualClock();
    const seen: number[] = [];
    const brokenBefore = 6;
    const { client } = scripted(
      clock,
      (index) => {
        if (index < brokenBefore) return { breaks: socketClosed() };
        if (index === brokenBefore) return { frames: [1], breaks: socketClosed() };
        if (index < brokenBefore * 2) return { breaks: socketClosed() };
        return { frames: [2] };
      },
      [runView({ status: 'COMPLETED' })],
    );

    const run = await follow(client, clock, seen);

    expect(run.status).toBe('COMPLETED');
    expect(seen).toEqual([1, 2]);
    expect(clock.now()).toBeGreaterThan(BOUND_MS);
  });
});

const serveStream = async (context: TestContext, body: string): Promise<{ client: RuntimeClient; requests: () => number }> => {
  const socketPath = path.join(withTempDir(context), 's.sock');
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const client = createRuntimeClient({ personCapability: async () => FAKE_PERSON_CAPABILITY, resolveSocket: fixedSocket(socketPath), clock: nodeClock });
  registerCleanup(context, async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { client, requests: () => requests };
};

const failedFrame = (data: unknown): string => `event: ${STREAM_FAILED_EVENT}\ndata: ${JSON.stringify(data)}\n\n`;

describe('a stream the daemon could not go on with', () => {
  it('reaches the follower as a typed failure with the cause, and is not tried again', async (context) => {
    const { client, requests } = await serveStream(context, failedFrame({ code: 'event_unreadable', message: 'event 7 of run run-1 has the unknown type run.corrupt' }));
    const clock = virtualClock();

    const outcome = await follow(client, clock).catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(StreamFailed);
    expect(outcome).toMatchObject({ code: 'event_unreadable' });
    expect((outcome as Error).message).toContain('event 7 of run run-1 has the unknown type run.corrupt');
    expect(isTransientStreamError(outcome)).toBe(false);
    expect(requests()).toBe(1);
    expect(clock.now()).toBe(0);
  });

  it('refuses a failure frame that names no code or no message', async (context) => {
    const { client } = await serveStream(context, failedFrame({ code: 'event_unreadable' }));

    await expect(follow(client, virtualClock())).rejects.toBeInstanceOf(ContractViolation);
  });
});
