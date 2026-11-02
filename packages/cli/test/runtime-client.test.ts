import http from 'node:http';
import path from 'node:path';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import type { TestContext } from 'vitest';
import { describe, expect, it } from 'vitest';
import { ContractViolation } from '../src/client/contract.ts';
import { RunApiError, createRunBody, createRuntimeClient, eventsHeadersOf, eventsQueryOf } from '../src/client/runtime-client.ts';
import type { RuntimeClient } from '../src/client/runtime-client.ts';
import { SESSION, runView } from './fake-backend.ts';

type Reply = { status: number; headers?: Record<string, string>; body: string };

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

const serve = async (context: TestContext, reply: (seen: Seen) => Reply): Promise<{ client: RuntimeClient; seen: Seen[] }> => {
  const socketPath = path.join(withTempDir(context), 's.sock');
  const seen: Seen[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const entry = { method: request.method ?? '', url: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks).toString('utf8') };
      seen.push(entry);
      const answer = reply(entry);
      response.writeHead(answer.status, answer.headers ?? { 'content-type': 'application/json' }).end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const client = createRuntimeClient({ socketPath });
  registerCleanup(context, async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { client, seen };
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Reply => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('request building', () => {
  it('sends only the input when no history is given, so the runtime default applies', () => {
    expect(createRunBody('Say hello')).toEqual({ input: 'Say hello' });
    expect(createRunBody('Start over', { history: 'fresh' })).toEqual({ input: 'Start over', history: 'fresh' });
  });

  it.each([
    { options: { after: 4 }, query: '?after=4', headers: { accept: 'text/event-stream' } },
    { options: { lastEventId: 7 }, query: '', headers: { accept: 'text/event-stream', 'last-event-id': '7' } },
    { options: {}, query: '', headers: { accept: 'text/event-stream' } },
    { options: { after: 0, lastEventId: 0 }, query: '?after=0', headers: { accept: 'text/event-stream', 'last-event-id': '0' } },
  ])('builds query $query and headers for $options, keeping a zero cursor', ({ options, query, headers }) => {
    expect(eventsQueryOf(options)).toBe(query);
    expect(eventsHeadersOf(options)).toEqual(headers);
  });
});

describe('createSession', () => {
  it('posts the cwd, the environment and only the options that were given', async (context) => {
    const { client, seen } = await serve(context, () => json(201, { session: SESSION, strippedEnvKeys: ['A'] }, { location: '/v1/sessions/session-1' }));

    const created = await client.createSession({ cwd: '/work', env: { HOME: '/h' }, permissionMode: 'plan' });

    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({ cwd: '/work', env: { HOME: '/h' }, permissionMode: 'plan' });
    expect(seen[0]?.headers['content-type']).toBe('application/json');
    expect(created.strippedEnvKeys).toEqual(['A']);
    expect(created.session.id).toBe('session-1');
  });

  it('rejects a body that does not match the Run API contract', async (context) => {
    const { client } = await serve(context, () => json(201, { session: { id: 'x' }, strippedEnvKeys: [] }));

    await expect(client.createSession({ cwd: '/work', env: {} })).rejects.toBeInstanceOf(ContractViolation);
  });
});

describe('errors', () => {
  it('keeps the status, the code and the message of an error body', async (context) => {
    const { client } = await serve(context, () => json(409, { error: { type: 'invalid_request_error', code: 'approval_not_pending', message: 'approval a1 is resolved, not pending' } }));

    const failure = await client.resolveApproval('a1', 'o').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RunApiError);
    expect(failure).toMatchObject({ status: 409, code: 'approval_not_pending', message: 'POST /v1/approvals/a1 answered 409: approval a1 is resolved, not pending' });
  });

  it('keeps the text of an answer that is not an error body', async (context) => {
    const { client } = await serve(context, () => ({ status: 502, body: 'bad gateway' }));

    const failure = await client.getRun('r1').catch((error: unknown) => error);

    expect(failure).toMatchObject({ status: 502, code: undefined, body: 'bad gateway' });
  });
});

describe('runs', () => {
  it('creates a run with the history and the idempotency key and returns the Location', async (context) => {
    const { client, seen } = await serve(context, () => json(202, { run: runView({ status: 'QUEUED' }) }, { location: '/v1/runs/run-1' }));

    const created = await client.createRun('session-1', 'hello', { history: 'fresh', idempotencyKey: 'key-1' });

    expect(created.location).toBe('/v1/runs/run-1');
    expect(seen[0]?.headers['idempotency-key']).toBe('key-1');
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({ input: 'hello', history: 'fresh' });
  });

  it('reports whether a cancel was accepted or the run had already ended', async (context) => {
    let status = 202;
    const { client } = await serve(context, () => json(status, { run: runView() }));

    expect((await client.cancel('run-1')).status).toBe(202);
    status = 200;
    expect((await client.cancel('run-1')).status).toBe(200);
  });
});

describe('streamEvents', () => {
  const event = (id: number, extra: Record<string, unknown> = {}): string =>
    `id: ${id}\nevent: agent.message.delta\ndata: ${JSON.stringify({ id, runId: 'run-1', sessionId: 'session-1', seq: id, step: 1, createdAt: 1, type: 'agent.message.delta', attempt: 0, itemId: 'm', text: String(id), ...extra })}\n\n`;

  it('yields validated frames, skips keep-alives and sends Last-Event-ID', async (context) => {
    const { client, seen } = await serve(context, () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: `: keep-alive\n\n${event(5)}${event(6)}`,
    }));

    const frames = [];
    for await (const frame of client.streamEvents('run-1', { lastEventId: 4 })) frames.push(frame);

    expect(frames.map((frame) => frame.id)).toEqual([5, 6]);
    expect(frames[0]?.data).toMatchObject({ type: 'agent.message.delta', text: '5' });
    expect(seen[0]?.headers['last-event-id']).toBe('4');
    expect(seen[0]?.url).toBe('/v1/runs/run-1/events');
  });

  it('rejects an event that is not a run event of the contract', async (context) => {
    const { client } = await serve(context, () => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: event(1, { type: 'made.up' }) }));

    const read = async (): Promise<void> => {
      for await (const _frame of client.streamEvents('run-1')) void _frame;
    };

    await expect(read()).rejects.toBeInstanceOf(ContractViolation);
  });

  it('rejects an event without an id', async (context) => {
    const { client } = await serve(context, () => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'data: {}\n\n' }));

    const read = async (): Promise<void> => {
      for await (const _frame of client.streamEvents('run-1')) void _frame;
    };

    await expect(read()).rejects.toThrow('an event without an id');
  });

  it('turns a refused cursor into a RunApiError', async (context) => {
    const { client } = await serve(context, () => json(400, { error: { type: 'invalid_request_error', code: 'invalid_request', message: 'the event cursor 9 is beyond the last event 3' } }));

    await expect(client.streamEvents('run-1', { lastEventId: 9 }).next()).rejects.toMatchObject({ status: 400 });
  });
});
