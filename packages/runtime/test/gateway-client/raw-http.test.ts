import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createFakeTimers, waitFor } from '@momonga/testkit';
import { dispositionOf } from '../../src/worker/gateway-policy.ts';
import {
  LISTED_PROVIDER,
  START_MS,
  TRACEPARENT,
  USER_AGENT,
  callOptions,
  collect,
  completedEvent,
  createdEvent,
  deltaEvent,
  expectGatewayError,
  fakeClock,
  listedEntry,
  listedMember,
  listedView,
  listingBody,
  makeClient,
  openSse,
  registerCleanup,
  settle,
  spiedTimers,
  sseFrame,
  startRawHttpFake,
  streamBody,
} from './fixtures.ts';

const MAIN = 'fake/main';
const SMALL = 'fake/small';

const COUNT_REQUEST = { model: 'default', input: [{ type: 'message' as const, role: 'user' as const, content: [{ type: 'input_text' as const, text: 'hi' }] }] };
const COMPACT_REQUEST = { model: 'default', input: COUNT_REQUEST.input };
const COMPACT_RESOURCE = { id: 'cmp_1', object: 'response.compaction', output: [] };
const compactFrame = (resource: unknown): string => `event: compaction\ndata: ${JSON.stringify(resource)}\n\n`;

const sseReply = (frames: string[]) => (_request: unknown, response: ServerResponse) => {
  openSse(response);
  response.end(frames.join(''));
};

describe('gateway client request headers', () => {
  it('streams events in order and sends the key, deadline, traceparent, user agent and JSON content type', async () => {
    const fake = await startRawHttpFake();
    fake.respond(sseReply([sseFrame(createdEvent), sseFrame(deltaEvent), sseFrame(completedEvent)]));
    const clock = fakeClock();
    const client = makeClient(fake.socketPath, clock);

    const events = await collect(client.stream(streamBody(), callOptions(clock, { idempotencyKey: 'key-1', deadlineInMs: 2500, traceparent: TRACEPARENT })));

    expect(events).toEqual([createdEvent, deltaEvent, completedEvent]);
    expect(fake.requests).toHaveLength(1);
    const [request] = fake.requests;
    expect(request).toMatchObject({ method: 'POST', url: '/v1/responses' });
    expect(request?.headers['idempotency-key']).toBe('"key-1"');
    expect(request?.headers['momonga-deadline-ms']).toBe('2500');
    expect(request?.headers['traceparent']).toBe(TRACEPARENT);
    expect(request?.headers['user-agent']).toBe(USER_AGENT);
    expect(request?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(request?.body ?? '')).toMatchObject({ model: 'default', input: streamBody().input });
  });

  it('sends the role and the run id as plain momonga headers, and sends neither when none is given', async () => {
    const fake = await startRawHttpFake();
    fake.respond(sseReply([sseFrame(completedEvent)]));
    const clock = fakeClock();
    const client = makeClient(fake.socketPath, clock);

    await collect(client.stream(streamBody(), { ...callOptions(clock), role: 'reflection', runId: 'run-9' }));
    await collect(client.stream(streamBody(), callOptions(clock, { idempotencyKey: 'key-2' })));

    expect(fake.requests[0]?.headers['momonga-role']).toBe('reflection');
    expect(fake.requests[0]?.headers['momonga-run-id']).toBe('run-9');
    expect(fake.requests[1]?.headers['momonga-role']).toBeUndefined();
    expect(fake.requests[1]?.headers['momonga-run-id']).toBeUndefined();
  });

  it('sends the session id of a call in momonga-session-id, and none for a call without one', async () => {
    const fake = await startRawHttpFake();
    fake.respond(sseReply([sseFrame(completedEvent)]));
    const clock = fakeClock();
    const client = makeClient(fake.socketPath, clock);

    await collect(client.stream(streamBody(), { ...callOptions(clock), sessionId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' }));
    await collect(client.stream(streamBody(), callOptions(clock, { idempotencyKey: 'key-2' })));

    expect(fake.requests[0]?.headers['momonga-session-id']).toBe('0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b');
    expect(fake.requests[1]?.headers['momonga-session-id']).toBeUndefined();
  });

  it('serialises the idempotency key as an sf-string, escaping quotes and backslashes', async () => {
    const fake = await startRawHttpFake();
    fake.respond(sseReply([sseFrame(completedEvent)]));
    const clock = fakeClock();
    const client = makeClient(fake.socketPath, clock);

    await collect(client.stream(streamBody(), callOptions(clock, { idempotencyKey: 'a"b\\c' })));

    expect(fake.requests[0]?.headers['idempotency-key']).toBe('"a\\"b\\\\c"');
  });

  it('omits traceparent when none is given', async () => {
    const fake = await startRawHttpFake();
    fake.respond(sseReply([sseFrame(completedEvent)]));
    const clock = fakeClock();
    const client = makeClient(fake.socketPath, clock);

    await collect(client.stream(streamBody(), callOptions(clock)));

    expect(fake.requests[0]?.headers).not.toHaveProperty('traceparent');
  });

  it('sends GET requests for models and health without a content type', async () => {
    const fake = await startRawHttpFake();
    fake.respond((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      if (request.url === '/v1/momonga/models') {
        response.end(JSON.stringify(listingBody([listedEntry(MAIN, { contextWindow: 8192 }, [listedMember(MAIN, { contextWindow: 8192 }, 'c'.repeat(64))])])));
      } else {
        response.end(JSON.stringify({ version: '1.0.0', apiVersion: 1, pid: 1, startedAt: 'x', state: 'running' }));
      }
    });
    const clock = fakeClock();
    const client = makeClient(fake.socketPath, clock);

    expect(await client.models()).toEqual([
      {
        ...listedView(MAIN),
        capabilities: { contextWindow: 8192 },
        chain: [{ model: MAIN, counter: 'c'.repeat(64), adapter: 'chat-completions', answers: 'model', upstream: MAIN, capabilities: { contextWindow: 8192 }, billing: 'metered' }],
      },
    ]);
    expect(await client.health()).toMatchObject({ version: '1.0.0', state: 'running' });

    expect(fake.requests.map((request) => [request.method, request.url])).toEqual([
      ['GET', '/v1/momonga/models'],
      ['GET', '/v1/momonga/health'],
    ]);
    for (const request of fake.requests) {
      expect(request.headers).not.toHaveProperty('content-type');
      expect(request.headers['user-agent']).toBe(USER_AGENT);
    }
  });

  it('answers the capabilities of a named member of the chain of the model, and refuses a member the gateway does not list for it', async () => {
    const fake = await startRawHttpFake();
    fake.respond((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(listingBody([listedEntry(MAIN, { contextWindow: 8192 }, [listedMember(MAIN, { contextWindow: 8192 }, '1'.repeat(64)), listedMember(SMALL, { contextWindow: 2000 }, '2'.repeat(64))])])),
      );
    });
    const client = makeClient(fake.socketPath, fakeClock());
    const signal = new AbortController().signal;

    expect(await client.capabilities(MAIN, { signal })).toEqual({ contextWindow: 8192 });
    expect(await client.capabilities(MAIN, { signal, target: SMALL })).toEqual({ contextWindow: 2000 });
    await expect(client.capabilities(MAIN, { signal, target: 'elsewhere' })).rejects.toThrow(/elsewhere/);
  });

  it('keeps the ordered chain of a model with the counter of each member, the pins of each member, and the roles and the start of the listing', async () => {
    const fake = await startRawHttpFake();
    fake.respond((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(
          listingBody(
            [
              listedEntry(SMALL, { contextWindow: 2000 }, [listedMember(SMALL, { contextWindow: 2000 }, '2'.repeat(64)), listedMember(MAIN, { contextWindow: 8192 }, '1'.repeat(64))]),
              listedEntry(MAIN, { contextWindow: 8192 }),
            ],
            { start: SMALL, roles: { compaction: MAIN } },
          ),
        ),
      );
    });
    const client = makeClient(fake.socketPath, fakeClock());
    const signal = new AbortController().signal;

    expect(await client.model(SMALL, { signal })).toEqual({
      id: SMALL,
      capabilities: { contextWindow: 2000 },
      chain: [
        { model: SMALL, counter: '2'.repeat(64), capabilities: { contextWindow: 2000 }, billed: { billing: 'metered', upstream: SMALL } },
        { model: MAIN, counter: '1'.repeat(64), capabilities: { contextWindow: 8192 }, billed: { billing: 'metered', upstream: MAIN } },
      ],
      targets: {
        [SMALL]: { adapter: 'chat-completions', model: SMALL, answers: 'model' },
        [MAIN]: { adapter: 'chat-completions', model: MAIN, answers: 'model' },
      },
      roles: { compaction: MAIN },
      views: [
        { canon: SMALL, provider: LISTED_PROVIDER, ownName: SMALL },
        { canon: MAIN, provider: LISTED_PROVIDER, ownName: MAIN },
      ],
    });
    const listing = await client.listing({ signal });
    expect(listing.start).toBe(SMALL);
    expect(listing.roles).toEqual({ compaction: MAIN });
    await expect(client.model('elsewhere', { signal })).rejects.toThrow(/elsewhere/);
  });

  it('leaves a fallback member that is being measured or is unavailable out of the chain of a model, and keeps its pins', async () => {
    const probing = { toolCalling: { state: 'probing', message: 'measuring this model (once per model and OS build)', retryAfterSeconds: 120, measuring: { fields: ['toolCalling'], step: null, elapsedSeconds: 0, declaration: 'declare toolCalling for the model in its settings' } }, source: 'unprobed' };
    const fake = await startRawHttpFake();
    fake.respond((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(listingBody([listedEntry(MAIN, { contextWindow: 8192 }, [listedMember(MAIN, { contextWindow: 8192 }), listedMember(SMALL, probing, '2'.repeat(64))])])));
    });
    const client = makeClient(fake.socketPath, fakeClock());

    const model = await client.model(MAIN, { signal: new AbortController().signal });

    expect(model.chain.map((member) => member.model)).toEqual([MAIN]);
    expect(Object.keys(model.targets)).toEqual([MAIN, SMALL]);
  });

  it('sends cancel as a body-less POST with the key and returns whether the gateway cancelled', async () => {
    const fake = await startRawHttpFake();
    let answer = true;
    fake.respond((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ cancelled: answer }));
    });
    const clock = fakeClock();
    const client = makeClient(fake.socketPath, clock);

    expect(await client.cancel('key-9', { signal: new AbortController().signal })).toBe(true);
    answer = false;
    expect(await client.cancel('key-9', { signal: new AbortController().signal })).toBe(false);

    const [request] = fake.requests;
    expect(request).toMatchObject({ method: 'POST', url: '/v1/momonga/responses/cancel', body: '' });
    expect(request?.headers['idempotency-key']).toBe('"key-9"');
    expect(request?.headers).not.toHaveProperty('content-type');
  });

  it('sends compact with the key and deadline and parses the resource', async () => {
    const fake = await startRawHttpFake();
    const resource = { id: 'cmp_1', object: 'response.compaction', output: [] };
    fake.respond((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(resource));
    });
    const clock = fakeClock();
    const client = makeClient(fake.socketPath, clock);

    expect(await client.compact(COMPACT_REQUEST, callOptions(clock, { idempotencyKey: 'cmp', deadlineInMs: 900 }))).toEqual(resource);

    const [request] = fake.requests;
    expect(request).toMatchObject({ method: 'POST', url: '/v1/responses/compact' });
    expect(request?.headers['idempotency-key']).toBe('"cmp"');
    expect(request?.headers['momonga-deadline-ms']).toBe('900');
    expect(request?.headers['content-type']).toBe('application/json');
  });
});

describe('gateway client pre-send deadline check', () => {
  it('throws deadline_exceeded without sending when the deadline has passed', async () => {
    const fake = await startRawHttpFake();
    fake.respond(sseReply([sseFrame(completedEvent)]));
    const clock = fakeClock();
    const client = makeClient(fake.socketPath, clock);

    const error = await settle(collect(client.stream(streamBody(), { ...callOptions(clock), deadlineAt: START_MS - 1 })));
    expectGatewayError(error, { status: 0, type: 'transport', code: 'deadline_exceeded' });

    const compactError = await settle(client.compact(COMPACT_REQUEST, { ...callOptions(clock), deadlineAt: START_MS - 1 }));
    expectGatewayError(compactError, { status: 0, type: 'transport', code: 'deadline_exceeded' });
    expect(fake.requests).toEqual([]);
  });
});

describe('gateway client error mapping', () => {
  it('parses a JSON error body and retry-after in seconds', async () => {
    const fake = await startRawHttpFake();
    fake.respond((_request, response) => {
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' });
      response.end(JSON.stringify({ error: { message: 'slow down', type: 'too_many_requests', param: null, code: 'rate_limited' } }));
    });
    const clock = fakeClock();
    const client = makeClient(fake.socketPath, clock);

    const error = await settle(collect(client.stream(streamBody(), callOptions(clock))));

    expectGatewayError(error, { status: 429, type: 'too_many_requests', code: 'rate_limited', message: 'slow down', retryAfterMs: 3000 });
  });

  it('carries the gateway deferral of a 429 on the error', async () => {
    const fake = await startRawHttpFake();
    fake.respond((_request, response) => {
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '100', 'momonga-deferred': 'true' });
      response.end(JSON.stringify({ error: { message: 'wait longer than the budget', type: 'too_many_requests', param: null, code: 'rate_limited' } }));
    });
    const clock = fakeClock();
    const client = makeClient(fake.socketPath, clock);

    const error = await settle(collect(client.stream(streamBody(), callOptions(clock))));

    expectGatewayError(error, { status: 429, type: 'too_many_requests', code: 'rate_limited', retryAfterMs: 100_000 });
    expect((error as { deferred?: boolean }).deferred).toBe(true);
  });

  it('leaves a 429 without the deferral header undeferred', async () => {
    const fake = await startRawHttpFake();
    fake.respond((_request, response) => {
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '20' });
      response.end(JSON.stringify({ error: { message: 'slow down', type: 'too_many_requests', param: null, code: 'rate_limited' } }));
    });
    const clock = fakeClock();
    const client = makeClient(fake.socketPath, clock);

    const error = await settle(collect(client.stream(streamBody(), callOptions(clock))));

    expect((error as { deferred?: boolean }).deferred).toBeUndefined();
  });

  it('carries the deferral of an error event on the error', async () => {
    const fake = await startRawHttpFake();
    const errorEvent = {
      type: 'error',
      sequence_number: 0,
      status: 429,
      retry_after_ms: 100_000,
      deferred: true,
      error: { type: 'too_many_requests', code: 'rate_limited', message: 'wait longer than the budget', param: null },
    };
    fake.respond(sseReply([': open\n\n', sseFrame(errorEvent)]));
    const client = makeClient(fake.socketPath, fakeClock());

    const error = await settle(collect(client.stream(streamBody(), callOptions(fakeClock()))));

    expect((error as { deferred?: boolean }).deferred).toBe(true);
  });

  it('parses retry-after as an HTTP date relative to the clock and keeps param', async () => {
    const fake = await startRawHttpFake();
    fake.respond((_request, response) => {
      response.writeHead(503, { 'content-type': 'application/json', 'retry-after': new Date(START_MS + 30_000).toUTCString() });
      response.end(JSON.stringify({ error: { message: 'closing', type: 'server_error', param: 'model', code: 'gateway_closed' } }));
    });
    const clock = fakeClock();
    const client = makeClient(fake.socketPath, clock);

    const error = await settle(client.countTokens(COUNT_REQUEST, { signal: new AbortController().signal }));

    expectGatewayError(error, { status: 503, type: 'server_error', code: 'gateway_closed', param: 'model', retryAfterMs: 30_000 });
  });

  it('maps a non-JSON 5xx body to server_error http_<status>', async () => {
    const fake = await startRawHttpFake();
    fake.respond((_request, response) => {
      response.writeHead(502, { 'content-type': 'text/plain' });
      response.end('Bad gateway');
    });
    const clock = fakeClock();
    const client = makeClient(fake.socketPath, clock);

    const error = await settle(client.health());

    expectGatewayError(error, { status: 502, type: 'server_error', code: 'http_502' });
    expect((error as { retryAfterMs?: number }).retryAfterMs).toBeUndefined();
  });

  it('maps an empty 4xx body to invalid_request http_<status>', async () => {
    const fake = await startRawHttpFake();
    fake.respond((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    const clock = fakeClock();
    const client = makeClient(fake.socketPath, clock);

    const error = await settle(collect(client.stream(streamBody(), callOptions(clock))));

    expectGatewayError(error, { status: 404, type: 'invalid_request', code: 'http_404' });
  });

  it('rejects a non-SSE reply to a stream request with unexpected_content_type', async () => {
    const fake = await startRawHttpFake();
    fake.respond((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(completedEvent.response));
    });
    const clock = fakeClock();
    const client = makeClient(fake.socketPath, clock);

    const error = await settle(collect(client.stream(streamBody(), callOptions(clock))));

    expectGatewayError(error, { status: 0, type: 'transport', code: 'unexpected_content_type' });
  });
});

describe('gateway client bounds', () => {
  const awaitingRequests = (fake: Awaited<ReturnType<typeof startRawHttpFake>>, count: number) =>
    waitFor(() => fake.requests.length === count, { description: `${count} request(s) to arrive` });

  it('times out a unary call after unaryTimeoutMs', async () => {
    const fake = await startRawHttpFake();
    fake.respond(() => {});
    const clock = fakeClock();
    const timers = createFakeTimers(clock);
    const client = makeClient(fake.socketPath, clock, { unaryTimeoutMs: 100, timers });

    const pending = settle(client.countTokens(COUNT_REQUEST, { signal: new AbortController().signal }));
    await awaitingRequests(fake, 1);
    timers.advance(100);

    expectGatewayError(await pending, { status: 0, type: 'transport', code: 'gateway_timeout' });
  });

  it('bounds a compaction by the call deadline', async () => {
    const fake = await startRawHttpFake();
    fake.respond(() => {});
    const clock = fakeClock();
    const timers = createFakeTimers(clock);
    const client = makeClient(fake.socketPath, clock, { unaryTimeoutMs: 600_000, timers });

    const pending = settle(client.compact(COMPACT_REQUEST, callOptions(clock, { deadlineInMs: 100 })));
    await awaitingRequests(fake, 1);
    timers.advance(100);

    expectGatewayError(await pending, { status: 0, type: 'transport', code: 'deadline_exceeded' });
  });

  it('times out cancel after cancelTimeoutMs', async () => {
    const fake = await startRawHttpFake();
    fake.respond(() => {});
    const clock = fakeClock();
    const timers = createFakeTimers(clock);
    const client = makeClient(fake.socketPath, clock, { cancelTimeoutMs: 100, unaryTimeoutMs: 600_000, timers });

    const pending = settle(client.cancel('key-1', { signal: new AbortController().signal }));
    await awaitingRequests(fake, 1);
    timers.advance(100);

    expectGatewayError(await pending, { status: 0, type: 'transport', code: 'gateway_timeout' });
  });

  it('lets a compaction, which is a model call, run until the deadline instead of unaryTimeoutMs', async () => {
    const fake = await startRawHttpFake();
    let answer: () => void = () => {};
    fake.respond((_request, response) => {
      answer = () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: 'cmp_1', object: 'response.compaction', output: [] }));
      };
    });
    const clock = fakeClock();
    const timers = createFakeTimers(clock);
    const client = makeClient(fake.socketPath, clock, { unaryTimeoutMs: 100, timers });

    const pending = client.compact(COMPACT_REQUEST, callOptions(clock, { deadlineInMs: 600_000 }));
    await awaitingRequests(fake, 1);
    timers.advance(400);
    answer();

    expect(await pending).toMatchObject({ id: 'cmp_1' });
  });

  it('interrupts a stream that stays silent for streamIdleTimeoutMs', async () => {
    const fake = await startRawHttpFake();
    fake.respond((_request, response) => {
      openSse(response);
      response.write(sseFrame(createdEvent));
    });
    const clock = fakeClock();
    const timers = spiedTimers(clock);
    const client = makeClient(fake.socketPath, clock, { streamIdleTimeoutMs: 150, timers });
    const seen: unknown[] = [];
    let armedAtFirstEvent = 0;
    let firstEventSeen: () => void = () => {};
    const firstEvent = new Promise<void>((resolve) => {
      firstEventSeen = resolve;
    });

    const finished = settle(
      (async () => {
        for await (const event of client.stream(streamBody(), callOptions(clock))) {
          seen.push(event);
          armedAtFirstEvent = timers.armed();
          firstEventSeen();
        }
      })(),
    );
    await firstEvent;
    await timers.untilArmed(armedAtFirstEvent + 1);
    timers.advance(150);
    const error = await finished;

    expect(seen).toEqual([createdEvent]);
    expectGatewayError(error, { status: 0, type: 'transport', code: 'stream_interrupted' });
  });

  it('interrupts a gateway that does not answer the request within streamIdleTimeoutMs', async () => {
    const fake = await startRawHttpFake();
    fake.respond(() => {});
    const clock = fakeClock();
    const timers = createFakeTimers(clock);
    const client = makeClient(fake.socketPath, clock, { streamIdleTimeoutMs: 150, timers });

    const pending = settle(collect(client.stream(streamBody(), callOptions(clock))));
    await waitFor(() => fake.requests.length === 1, { description: 'the request to arrive' });
    timers.advance(150);

    expectGatewayError(await pending, { status: 0, type: 'transport', code: 'stream_interrupted' });
  });

  it('interrupts a gateway that opens the stream and then stays silent for streamIdleTimeoutMs', async () => {
    const fake = await startRawHttpFake();
    fake.respond((_request, response) => {
      openSse(response);
      response.write(': open\n\n');
    });
    const clock = fakeClock();
    const timers = spiedTimers(clock);
    const client = makeClient(fake.socketPath, clock, { streamIdleTimeoutMs: 150, timers });

    const pending = settle(collect(client.stream(streamBody(), callOptions(clock))));
    await waitFor(() => fake.requests.length === 1, { description: 'the request to arrive' });
    await timers.untilArmed(3);
    timers.advance(150);

    expectGatewayError(await pending, { status: 0, type: 'transport', code: 'stream_interrupted' });
  });

  it('completes when the gateway keeps the stream alive with comments longer than streamIdleTimeoutMs before its first event', async () => {
    const fake = await startRawHttpFake();
    let open: ServerResponse | undefined;
    fake.respond((_request, response) => {
      open = response;
      openSse(response);
      response.write(': keep-alive\n\n');
    });
    const clock = fakeClock();
    const timers = spiedTimers(clock);
    const client = makeClient(fake.socketPath, clock, { streamIdleTimeoutMs: 150, timers });

    const seen = collect(client.stream(streamBody(), callOptions(clock)));
    await waitFor(() => open !== undefined, { description: 'the stream to open' });
    await timers.untilArmed(3);
    for (let round = 0; round < 4; round += 1) {
      const armedBefore = timers.armed();
      (open as ServerResponse).write(': keep-alive\n\n');
      await timers.untilArmed(armedBefore + 1);
      timers.advance(100);
    }
    (open as ServerResponse).end(sseFrame(createdEvent) + sseFrame(completedEvent));

    expect(await seen).toEqual([createdEvent, completedEvent]);
  });

  it('still bounds the wait for the first answer by the call deadline', async () => {
    const fake = await startRawHttpFake();
    fake.respond(() => {});
    const clock = fakeClock();
    const timers = createFakeTimers(clock);
    const client = makeClient(fake.socketPath, clock, { streamIdleTimeoutMs: 150, timers });

    const pending = settle(collect(client.stream(streamBody(), callOptions(clock, { deadlineInMs: 100 }))));
    await waitFor(() => fake.requests.length === 1, { description: 'the request to arrive' });
    timers.advance(100);

    expectGatewayError(await pending, { status: 0, type: 'transport', code: 'deadline_exceeded' });
  });

  it('turns an error event that carries a status into the same error an HTTP reply of that status gives', async () => {
    const fake = await startRawHttpFake();
    const errorEvent = {
      type: 'error',
      sequence_number: 0,
      status: 429,
      retry_after_ms: 7000,
      error: { type: 'too_many_requests', code: 'rate_limited', message: 'slow down', param: null },
    };
    fake.respond(sseReply([': open\n\n', sseFrame(errorEvent)]));
    const client = makeClient(fake.socketPath, fakeClock());

    const error = await settle(collect(client.stream(streamBody(), callOptions(fakeClock()))));

    expectGatewayError(error, { status: 429, type: 'too_many_requests', code: 'rate_limited', retryAfterMs: 7000 });
  });

  it.for([
    { code: 'gateway_closed', retryAfterMs: 30_000, expected: { kind: 'requeue', refund: true, retryAfterMs: 30_000, interrupted: false } },
    { code: 'provider_unavailable', retryAfterMs: undefined, expected: { kind: 'requeue', refund: false, interrupted: false } },
  ])('lets the worker requeue or fail a $code error event exactly as it does an HTTP reply', async ({ code, retryAfterMs, expected }) => {
    const fake = await startRawHttpFake();
    const errorEvent = {
      type: 'error',
      sequence_number: 0,
      status: 503,
      ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs }),
      error: { type: 'server_error', code, message: 'no target answers', param: null },
    };
    fake.respond(sseReply([': keep-alive\n\n', sseFrame(errorEvent)]));
    const clock = fakeClock();
    const client = makeClient(fake.socketPath, clock);

    const error = await settle(collect(client.stream(streamBody(), callOptions(clock))));

    expect(dispositionOf(error, 0)).toMatchObject(expected);
  });

  it('tells the gateway its idle bound in the momonga-stream-idle-ms header', async () => {
    const fake = await startRawHttpFake();
    fake.respond((_request, response) => {
      openSse(response);
      response.end(sseFrame(createdEvent) + sseFrame(completedEvent));
    });
    const clock = fakeClock();
    const client = makeClient(fake.socketPath, clock, { streamIdleTimeoutMs: 4321 });

    await collect(client.stream(streamBody(), callOptions(clock)));

    expect(fake.requests[0]?.headers['momonga-stream-idle-ms']).toBe('4321');
  });

  it('tells the gateway its idle bound on a compaction too', async () => {
    const fake = await startRawHttpFake();
    fake.respond((_request, response) => {
      openSse(response);
      response.end(compactFrame(COMPACT_RESOURCE));
    });
    const clock = fakeClock();
    const client = makeClient(fake.socketPath, clock, { streamIdleTimeoutMs: 4321 });

    await client.compact(COMPACT_REQUEST, callOptions(clock));

    expect(fake.requests[0]?.headers['momonga-stream-idle-ms']).toBe('4321');
  });

  it('interrupts a compaction whose gateway stays silent for streamIdleTimeoutMs', async () => {
    const fake = await startRawHttpFake();
    fake.respond(() => {});
    const clock = fakeClock();
    const timers = createFakeTimers(clock);
    const client = makeClient(fake.socketPath, clock, { streamIdleTimeoutMs: 150, timers });

    const pending = settle(client.compact(COMPACT_REQUEST, callOptions(clock)));
    await waitFor(() => fake.requests.length === 1, { description: 'the request to arrive' });
    timers.advance(150);

    expectGatewayError(await pending, { status: 0, type: 'transport', code: 'stream_interrupted' });
  });

  it('interrupts a compaction whose gateway opens the stream and then goes silent', async () => {
    const fake = await startRawHttpFake();
    fake.respond((_request, response) => {
      openSse(response);
      response.write(': keep-alive\n\n');
    });
    const clock = fakeClock();
    const timers = spiedTimers(clock);
    const client = makeClient(fake.socketPath, clock, { streamIdleTimeoutMs: 150, timers });

    const pending = settle(client.compact(COMPACT_REQUEST, callOptions(clock)));
    await waitFor(() => fake.requests.length === 1, { description: 'the request to arrive' });
    await timers.untilArmed(3);
    timers.advance(150);

    expectGatewayError(await pending, { status: 0, type: 'transport', code: 'stream_interrupted' });
  });

  it('completes a compaction that the gateway keeps alive with comments for longer than streamIdleTimeoutMs', async () => {
    const fake = await startRawHttpFake();
    let open: ServerResponse | undefined;
    fake.respond((_request, response) => {
      open = response;
      openSse(response);
      response.write(': keep-alive\n\n');
    });
    const clock = fakeClock();
    const timers = spiedTimers(clock);
    const client = makeClient(fake.socketPath, clock, { streamIdleTimeoutMs: 150, timers });

    const pending = client.compact(COMPACT_REQUEST, callOptions(clock));
    await waitFor(() => open !== undefined, { description: 'the stream to open' });
    await timers.untilArmed(3);
    for (let round = 0; round < 4; round += 1) {
      const armedBefore = timers.armed();
      (open as ServerResponse).write(': keep-alive\n\n');
      await timers.untilArmed(armedBefore + 1);
      timers.advance(100);
    }
    (open as ServerResponse).end(compactFrame(COMPACT_RESOURCE));

    expect(await pending).toEqual(COMPACT_RESOURCE);
  });

  it('turns an error event of a compaction into the same error an HTTP reply of that status gives', async () => {
    const fake = await startRawHttpFake();
    const errorEvent = {
      type: 'error',
      sequence_number: 0,
      status: 503,
      retry_after_ms: 30_000,
      error: { type: 'server_error', code: 'all_targets_unavailable', message: 'every target is cooling down', param: null },
    };
    fake.respond(sseReply([': keep-alive\n\n', sseFrame(errorEvent)]));
    const clock = fakeClock();
    const client = makeClient(fake.socketPath, clock);

    const error = await settle(client.compact(COMPACT_REQUEST, callOptions(clock)));

    expectGatewayError(error, { status: 503, type: 'server_error', code: 'all_targets_unavailable', retryAfterMs: 30_000 });
  });

  it('reports a compaction stream that ends without a result as interrupted', async () => {
    const fake = await startRawHttpFake();
    fake.respond(sseReply([': keep-alive\n\n']));
    const clock = fakeClock();
    const client = makeClient(fake.socketPath, clock);

    const error = await settle(client.compact(COMPACT_REQUEST, callOptions(clock)));

    expectGatewayError(error, { status: 0, type: 'transport', code: 'stream_interrupted' });
  });

  it('treats keep-alive comments as activity', async () => {
    const fake = await startRawHttpFake();
    let open: ServerResponse | undefined;
    fake.respond((_request, response) => {
      open = response;
      openSse(response);
      response.write(sseFrame(createdEvent));
    });
    const clock = fakeClock();
    const timers = spiedTimers(clock);
    const client = makeClient(fake.socketPath, clock, { streamIdleTimeoutMs: 150, timers });
    let armedAtFirstEvent = 0;
    let firstEventSeen: () => void = () => {};
    const firstEvent = new Promise<void>((resolve) => {
      firstEventSeen = resolve;
    });
    const seen: unknown[] = [];

    const finished = (async () => {
      for await (const event of client.stream(streamBody(), callOptions(clock))) {
        seen.push(event);
        if (seen.length === 1) {
          armedAtFirstEvent = timers.armed();
          firstEventSeen();
        }
      }
    })();
    await firstEvent;
    await timers.untilArmed(armedAtFirstEvent + 1);
    for (let round = 0; round < 4; round += 1) {
      const armedBefore = timers.armed();
      (open as ServerResponse).write(': ping\n\n');
      await timers.untilArmed(armedBefore + 1);
      timers.advance(100);
    }
    (open as ServerResponse).end(sseFrame(completedEvent));
    await finished;

    expect(seen).toEqual([createdEvent, completedEvent]);
  });
});

describe('gateway client aborts and teardown', () => {
  it("rejects with the caller's string reason 'cancel' unchanged", async () => {
    const fake = await startRawHttpFake();
    fake.respond(() => {});
    const clock = fakeClock();
    const client = makeClient(fake.socketPath, clock);
    const controller = new AbortController();

    const pending = settle(collect(client.stream(streamBody(), callOptions(clock, { signal: controller.signal }))));
    await waitFor(() => fake.requests.length === 1, { description: 'the stream request to arrive' });
    controller.abort('cancel');

    expect(await pending).toBe('cancel');
  });

  it('rejects mid-stream with the exact abort reason object', async () => {
    const fake = await startRawHttpFake();
    fake.respond((_request, response) => {
      openSse(response);
      response.write(sseFrame(createdEvent));
    });
    const clock = fakeClock();
    const client = makeClient(fake.socketPath, clock);
    const controller = new AbortController();
    const reason = new DOMException('stop now', 'AbortError');

    const error = await settle(
      (async () => {
        for await (const _event of client.stream(streamBody(), callOptions(clock, { signal: controller.signal }))) controller.abort(reason);
      })(),
    );

    expect(error).toBe(reason);
  });

  it('rejects a unary call with the abort reason unchanged', async () => {
    const fake = await startRawHttpFake();
    fake.respond(() => {});
    const clock = fakeClock();
    const client = makeClient(fake.socketPath, clock);
    const controller = new AbortController();
    const reason = new Error('caller gave up');

    const pending = settle(client.countTokens(COUNT_REQUEST, { signal: controller.signal }));
    await waitFor(() => fake.requests.length === 1, { description: 'the count request to arrive' });
    controller.abort(reason);

    expect(await pending).toBe(reason);
  });

  it('closes the connection when the consumer stops iterating', async () => {
    const fake = await startRawHttpFake();
    fake.respond((_request, response) => {
      openSse(response);
      response.write(sseFrame(createdEvent));
    });
    const clock = fakeClock();
    const client = makeClient(fake.socketPath, clock);

    for await (const event of client.stream(streamBody(), callOptions(clock))) {
      expect(event).toEqual(createdEvent);
      break;
    }

    await waitFor(() => fake.closedConnections() === 1, { description: 'the stream connection to close' });
    expect(fake.closedConnections()).toBe(1);
  });

  it('rejects an open stream with client_destroyed when the client is destroyed', async () => {
    const fake = await startRawHttpFake();
    fake.respond((_request, response) => {
      openSse(response);
      response.write(sseFrame(createdEvent));
    });
    const clock = fakeClock();
    const client = makeClient(fake.socketPath, clock);
    const iterator = client.stream(streamBody(), callOptions(clock))[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: createdEvent });
    const next = settle(iterator.next());

    await client.destroy();

    expectGatewayError(await next, { status: 0, type: 'transport', code: 'client_destroyed' });
  });
});
