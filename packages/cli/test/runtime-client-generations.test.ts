import http from 'node:http';
import path from 'node:path';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import type { TestContext } from 'vitest';
import { describe, expect, it } from 'vitest';
import { ContractViolation } from '../src/client/contract.ts';
import { DaemonMoved, MOVED_RESENDS, RunApiError, createRuntimeClient } from '../src/client/runtime-client.ts';
import type { RuntimeClient } from '../src/client/runtime-client.ts';
import { SESSION, runView } from './fake-backend.ts';

type Reply = { status: number; headers?: Record<string, string>; body: string } | 'destroy';

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; socket: string };

const MOVED_TEXT = 'This daemon has been replaced by a newer version and accepts no new work. The request was not run; send it again.';

const moved: Reply = { status: 503, headers: { 'content-type': 'application/json', 'retry-after': '1', connection: 'close' }, body: JSON.stringify({ error: { type: 'server_error', code: 'moved', message: MOVED_TEXT } }) };

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Reply => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

const listen = async (context: TestContext, name: string, seen: Seen[], reply: (entry: Seen) => Reply): Promise<string> => {
  const socketPath = path.join(withTempDir(context), `${name}.sock`);
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const entry = { method: request.method ?? '', url: request.url ?? '', headers: request.headers, socket: name };
      seen.push(entry);
      const answer = reply(entry);
      if (answer === 'destroy') {
        request.socket.destroy();
        return;
      }
      response.writeHead(answer.status, answer.headers ?? { 'content-type': 'application/json' }).end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  registerCleanup(context, async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return socketPath;
};

const clientOver = (context: TestContext, resolveSocket: () => Promise<string>): { client: RuntimeClient; sleeps: number[] } => {
  const sleeps: number[] = [];
  const client = createRuntimeClient({ resolveSocket, clock: { now: () => Date.now(), sleep: async (ms) => void sleeps.push(ms) } });
  registerCleanup(context, () => client.close());
  return { client, sleeps };
};

describe('a request answered moved (20.33)', () => {
  it('is resent after retry-after through the resolver, which now names the serving generation', async (context) => {
    const seen: Seen[] = [];
    const retiring = await listen(context, 'retiring', seen, () => moved);
    const serving = await listen(context, 'serving', seen, () => json(201, { session: SESSION, strippedEnvKeys: [] }));
    let resolved = retiring;
    const { client, sleeps } = clientOver(context, async () => resolved);

    const first = client.createSession({ cwd: '/work', env: {} });
    resolved = serving;
    const created = await first;

    expect(created.session.id).toBe(SESSION.id);
    expect(seen.map((entry) => entry.socket)).toEqual(['retiring', 'serving']);
    expect(sleeps).toEqual([1000]);
  });

  it('is resent at most three times, then raised with the 503 text', async (context) => {
    const seen: Seen[] = [];
    const retiring = await listen(context, 'retiring', seen, () => moved);
    const { client, sleeps } = clientOver(context, async () => retiring);

    const failure = await client.createSession({ cwd: '/work', env: {} }).catch((error: unknown) => error);

    expect(MOVED_RESENDS).toBe(3);
    expect(failure).toBeInstanceOf(RunApiError);
    expect(failure).toMatchObject({ status: 503, code: 'moved', reason: MOVED_TEXT });
    expect(seen).toHaveLength(4);
    expect(sleeps).toEqual([1000, 1000, 1000]);
  });

  it('asks its owner before each resend, and raises what the owner raises without sending again (20.69)', async (context) => {
    const seen: Seen[] = [];
    const retiring = await listen(context, 'retiring', seen, () => moved);
    const sleeps: number[] = [];
    const ended = new Error('momonga was updated to v1.2.4; reopen this session.');
    const client = createRuntimeClient({
      resolveSocket: async () => retiring,
      clock: { now: () => Date.now(), sleep: async (ms) => void sleeps.push(ms) },
      onMoved: async () => {
        throw ended;
      },
    });
    registerCleanup(context, () => client.close());

    const failure = await client.createSession({ cwd: '/work', env: {} }).catch((error: unknown) => error);

    expect(failure).toBe(ended);
    expect(seen).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('resends a request of every kind, since a moved answer means it was not processed', async (context) => {
    const seen: Seen[] = [];
    let answered = 0;
    const socket = await listen(context, 'runtime', seen, () => {
      answered += 1;
      return answered === 1 ? moved : json(202, { run: runView() }, { location: '/v1/runs/run-1' });
    });
    const { client } = clientOver(context, async () => socket);

    const created = await client.createRun('session-1', 'go');

    expect(created.run.id).toBe('run-1');
    expect(seen.map((entry) => entry.method)).toEqual(['POST', 'POST']);
  });
});

describe('a socket error before any response byte (20.34)', () => {
  it('resends a GET once', async (context) => {
    const seen: Seen[] = [];
    let answered = 0;
    const socket = await listen(context, 'runtime', seen, () => {
      answered += 1;
      return answered === 1 ? 'destroy' : json(200, { run: runView() });
    });
    const { client } = clientOver(context, async () => socket);

    expect((await client.getRun('run-1')).id).toBe('run-1');
    expect(seen).toHaveLength(2);
  });

  it('surfaces the error when the resend fails too', async (context) => {
    const seen: Seen[] = [];
    const socket = await listen(context, 'runtime', seen, () => 'destroy');
    const { client } = clientOver(context, async () => socket);

    await expect(client.getRun('run-1')).rejects.toMatchObject({ code: expect.stringMatching(/^(UND_ERR_SOCKET|ECONNRESET|EPIPE)$/) });
    expect(seen).toHaveLength(2);
  });

  it('resends a POST that carries an idempotency key once', async (context) => {
    const seen: Seen[] = [];
    let answered = 0;
    const socket = await listen(context, 'runtime', seen, () => {
      answered += 1;
      return answered === 1 ? 'destroy' : json(202, { run: runView() }, { location: '/v1/runs/run-1' });
    });
    const { client } = clientOver(context, async () => socket);

    await client.createRun('session-1', 'go', { idempotencyKey: 'key-1' });

    expect(seen.map((entry) => entry.headers['idempotency-key'])).toEqual(['key-1', 'key-1']);
  });

  it('does not resend a POST without an idempotency key', async (context) => {
    const seen: Seen[] = [];
    const socket = await listen(context, 'runtime', seen, () => 'destroy');
    const { client } = clientOver(context, async () => socket);

    await expect(client.createRun('session-1', 'go')).rejects.toMatchObject({ code: expect.stringMatching(/^(UND_ERR_SOCKET|ECONNRESET|EPIPE)$/) });
    expect(seen).toHaveLength(1);
  });
});

describe('the daemon.current frame of a stream (20.44)', () => {
  const event = (id: number): string =>
    `id: ${id}\nevent: agent.message.delta\ndata: ${JSON.stringify({ id, runId: 'run-1', sessionId: 'session-1', seq: id, step: 1, createdAt: 1, type: 'agent.message.delta', attempt: 0, itemId: 'm', text: String(id) })}\n\n`;

  const stream = (body: string): Reply => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body });

  it('ends the stream with DaemonMoved after the frames before it', async (context) => {
    const seen: Seen[] = [];
    const socket = await listen(context, 'runtime', seen, () => stream(`${event(1)}event: daemon.current\ndata: {"generation":2,"version":"1.2.4"}\n\n`));
    const { client } = clientOver(context, async () => socket);
    const ids: number[] = [];

    const read = async (): Promise<void> => {
      for await (const frame of client.streamEvents('run-1')) ids.push(frame.id);
    };

    const failure = await read().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DaemonMoved);
    expect(failure).toMatchObject({ generation: 2, version: '1.2.4' });
    expect(ids).toEqual([1]);
  });

  it('still rejects any other frame without an id, and a daemon.current frame that names no generation', async (context) => {
    const seen: Seen[] = [];
    let answered = 0;
    const socket = await listen(context, 'runtime', seen, () => {
      answered += 1;
      return stream(answered === 1 ? 'event: something.else\ndata: {}\n\n' : 'event: daemon.current\ndata: {}\n\n');
    });
    const { client } = clientOver(context, async () => socket);
    const read = async (): Promise<void> => {
      for await (const _frame of client.streamEvents('run-1')) void _frame;
    };

    await expect(read()).rejects.toThrow('an event without an id');
    await expect(read()).rejects.toBeInstanceOf(ContractViolation);
  });
});
