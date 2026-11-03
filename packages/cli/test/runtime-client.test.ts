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

  it('adds the skill only when one is named', () => {
    expect(createRunBody('/pdf summarize', { skill: 'pdf' })).toEqual({ input: '/pdf summarize', skill: 'pdf' });
    expect(createRunBody('summarize', { history: 'inherit', skill: 'pdf' })).toEqual({ input: 'summarize', history: 'inherit', skill: 'pdf' });
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

  it('posts the MCP servers of the session when they are given', async (context) => {
    const { client, seen } = await serve(context, () => json(201, { session: SESSION, strippedEnvKeys: [] }, { location: '/v1/sessions/session-1' }));
    const mcpServers = { fx: { type: 'stdio' as const, command: 'node', args: ['server.js'], env: { A: 'b' } } };

    await client.createSession({ cwd: '/work', env: {}, mcpServers });

    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({ cwd: '/work', env: {}, mcpServers });
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

describe('sessions', () => {
  it('reads a session by id', async (context) => {
    const { client, seen } = await serve(context, () => json(200, { session: SESSION }));

    expect(await client.getSession('session-1')).toEqual(SESSION);
    expect(`${seen[0]?.method} ${seen[0]?.url}`).toBe('GET /v1/sessions/session-1');
  });

  it('lists the runs of a session in the order the API gives them', async (context) => {
    const { client, seen } = await serve(context, () => json(200, { runs: [runView({ id: 'run-1', ordinal: 1 }), runView({ id: 'run-2', ordinal: 2 })] }));

    expect((await client.listRuns('session-1')).map((run) => run.id)).toEqual(['run-1', 'run-2']);
    expect(`${seen[0]?.method} ${seen[0]?.url}`).toBe('GET /v1/sessions/session-1/runs');
  });

  it('reads the skills of a session and rejects a body that is not the skills contract', async (context) => {
    const skills = { skills: [{ name: 'pdf', description: 'Extract PDF text', scope: 'project', location: '/work/.agents/skills/pdf/SKILL.md' }], warnings: ['w'] };
    const good = await serve(context, () => json(200, skills));

    expect(await good.client.skills('session-1')).toEqual(skills);
    expect(good.seen[0]?.url).toBe('/v1/sessions/session-1/skills');
    const bad = await serve(context, () => json(200, { skills: [{ name: 'pdf' }], warnings: [] }));
    await expect(bad.client.skills('session-1')).rejects.toBeInstanceOf(ContractViolation);
  });

  it('replaces the MCP servers of a session with a PATCH that carries nothing else', async (context) => {
    const { client, seen } = await serve(context, () => json(200, { session: SESSION }));
    const servers = { docs: { type: 'http' as const, url: 'https://example.com/mcp', headers: {} } };

    await client.setMcpServers('session-1', servers);

    expect(`${seen[0]?.method} ${seen[0]?.url}`).toBe('PATCH /v1/sessions/session-1');
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({ mcpServers: servers });
  });

  it('switches the model alias of a session with a PATCH that carries nothing else, and returns the session', async (context) => {
    const { client, seen } = await serve(context, () => json(200, { session: { ...SESSION, modelAlias: 'fm-large' } }));

    const session = await client.setModelAlias('session-1', 'fm-large');

    expect(`${seen[0]?.method} ${seen[0]?.url}`).toBe('PATCH /v1/sessions/session-1');
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({ modelAlias: 'fm-large' });
    expect(session.modelAlias).toBe('fm-large');
  });

  it('keeps the refusal of an alias the gateway does not list', async (context) => {
    const { client } = await serve(context, () => json(400, { error: { type: 'invalid_request_error', code: 'invalid_request', message: 'unknown model alias nope', param: 'modelAlias' } }));

    await expect(client.setModelAlias('session-1', 'nope')).rejects.toMatchObject({ status: 400, reason: expect.stringContaining('unknown model alias nope') });
  });
});

describe('elicitations', () => {
  const ELICITATION = {
    id: 'in-1',
    runId: 'run-1',
    callId: 'call-1',
    status: 'pending',
    server: 'remote',
    requests: [{ key: 'who', mode: 'form', message: 'Who are you?', requestedSchema: { type: 'object' } }],
    expiresAt: 10,
    createdAt: 1,
    toolCall: { callId: 'call-1', name: 'mcp__remote__ask', title: 'Ask' },
  };

  it('reads an elicitation and rejects a body that is not the elicitation contract', async (context) => {
    const good = await serve(context, () => json(200, { elicitation: ELICITATION }));

    expect(await good.client.getElicitation('in-1')).toEqual(ELICITATION);
    expect(`${good.seen[0]?.method} ${good.seen[0]?.url}`).toBe('GET /v1/elicitations/in-1');
    const bad = await serve(context, () => json(200, { elicitation: { id: 'in-1' } }));
    await expect(bad.client.getElicitation('in-1')).rejects.toBeInstanceOf(ContractViolation);
  });

  it('posts the answers by key and returns the elicitation with its run', async (context) => {
    const { client, seen } = await serve(context, () => json(200, { elicitation: { ...ELICITATION, status: 'resolved' }, run: runView({ status: 'RUNNING' }) }));
    const responses = { who: { action: 'accept' as const, content: { name: 'Ada' } } };

    const resolved = await client.resolveElicitation('in-1', responses);

    expect(`${seen[0]?.method} ${seen[0]?.url}`).toBe('POST /v1/elicitations/in-1');
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({ responses });
    expect(resolved.elicitation.status).toBe('resolved');
    expect(resolved.run.status).toBe('RUNNING');
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

  it('names the skill of a run in the body', async (context) => {
    const { client, seen } = await serve(context, () => json(202, { run: runView({ status: 'QUEUED' }) }, { location: '/v1/runs/run-1' }));

    await client.createRun('session-1', '/pdf summarize', { skill: 'pdf' });

    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({ input: '/pdf summarize', skill: 'pdf' });
  });

  it('reports whether a cancel was accepted or the run had already ended', async (context) => {
    let status = 202;
    const { client } = await serve(context, () => json(status, { run: runView() }));

    expect((await client.cancel('run-1')).status).toBe(202);
    status = 200;
    expect((await client.cancel('run-1')).status).toBe(200);
  });
});

describe('the token anatomy endpoints', () => {
  const breakdown = {
    calls: 1,
    layers: { estimated: true, shares: {}, tokens: {}, callsWithoutAnatomy: 1 },
    billed: { inputTokens: 0, uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 3, reasoningTokens: 0 },
    cacheHitRatio: null,
    timeToFirstToken: null,
    duration: null,
    roles: { run: { calls: 1, timeToFirstToken: null, duration: null, totalDurationMs: null, timingNotRecorded: 1 } },
    callsWithoutResponseId: 0,
    cost: { amount: null, currency: 'USD', unpricedCalls: 1 },
    unpriced: [],
    inconsistentUsage: [{ runId: 'run-1', provider: 'acme', model: 'm1', step: 2, reason: 'cached input (60) and written input (50) together exceed the input (100)' }],
    unjoined: [],
  };

  it('accepts a breakdown that lists the calls with inconsistent usage', async (context) => {
    const { client } = await serve(context, () => json(200, breakdown));

    expect((await client.costBreakdown({ run: 'run-1' })).inconsistentUsage).toHaveLength(1);
  });

  it('refuses a breakdown that does not say which calls were left out of the by-kind sums', async (context) => {
    const { inconsistentUsage: _omitted, ...incomplete } = breakdown;
    const { client } = await serve(context, () => json(200, incomplete));

    await expect(client.costBreakdown({ run: 'run-1' })).rejects.toBeInstanceOf(ContractViolation);
  });

  it('reads the reflection job and charge of a run and refuses a body without the charge', async (context) => {
    const good = await serve(context, () => json(200, { job: null, charges: [] }));
    expect(await good.client.runReflection('run-1')).toEqual({ job: null, charges: [] });
    expect(good.seen[0]?.url).toBe('/v1/runs/run-1/reflection');

    const bad = await serve(context, () => json(200, { job: null, charge: null }));
    await expect(bad.client.runReflection('run-1')).rejects.toBeInstanceOf(ContractViolation);
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
