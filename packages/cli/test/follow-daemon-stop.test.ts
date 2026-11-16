import http from 'node:http';
import path from 'node:path';
import { fixedSocket } from '@momonga/foundation';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import { createRuntimeClient } from '../src/client/runtime-client.ts';
import { nodeClock } from '../src/node-ports.ts';
import { followRun } from '../src/run/follow.ts';
import { virtualClock } from './fake-supervisor.ts';

const FAKE_PERSON_CAPABILITY = 'f'.repeat(32);

const STOPPING_FRAME = 'event: daemon.stopping\ndata: {}\n\n';

const deltaOf = (id: number): string =>
  `id: ${id}\nevent: agent.message.delta\ndata: ${JSON.stringify({ type: 'agent.message.delta', id, runId: 'run-1', sessionId: 'session-1', seq: id, step: 1, createdAt: 1, attempt: 0, itemId: 'm', text: String(id) })}\n\n`;

const secondFrame = deltaOf(2);

const deltaFrame = `id: 1\nevent: agent.message.delta\ndata: ${JSON.stringify({ type: 'agent.message.delta', id: 1, runId: 'run-1', sessionId: 'session-1', seq: 1, step: 1, createdAt: 1, attempt: 0, itemId: 'm', text: '1' })}\n\n`;

class Restored extends Error {}

describe('a daemon that stops under an open follower (real-use-30)', () => {
  it('tells the follower once when the stop begins, delivers the events of the drain, and reaches it as a reconnect when the stop closes the socket', async (context) => {
    const socketPath = path.join(withTempDir(context), 's.sock');
    let opened!: () => void;
    const streaming = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      response.write(deltaFrame);
      response.write(STOPPING_FRAME);
      response.write(STOPPING_FRAME);
      response.write(secondFrame);
      opened();
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const client = createRuntimeClient({ personCapability: async () => FAKE_PERSON_CAPABILITY, resolveSocket: fixedSocket(socketPath), clock: nodeClock });
    registerCleanup(context, () => client.close());
    const reconnecting: number[] = [];
    const seen: number[] = [];
    const stopping: number[] = [];
    const followed = followRun({
      client,
      clock: virtualClock(),
      random: () => 0.5,
      runId: 'run-1',
      reconnectBoundMs: 60_000,
      restoreConnection: async () => {
        throw new Restored('restore asked');
      },
      onEvent: (frame) => seen.push(frame.id),
      onDaemonStopping: () => stopping.push(seen.length),
      onReconnecting: (attempt) => reconnecting.push(attempt),
    }).catch((error: unknown) => error);
    await streaming;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    expect(await followed).toBeInstanceOf(Restored);
    expect(seen).toEqual([1, 2]);
    expect(stopping).toEqual([1]);
    expect(reconnecting).toEqual([0]);
  });
});
