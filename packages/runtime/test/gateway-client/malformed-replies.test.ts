import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  callOptions,
  collect,
  createdEvent,
  expectGatewayError,
  fakeClock,
  listedEntry,
  listedMember,
  listingBody,
  makeClient,
  openSse,
  settle,
  spiedTimers,
  sseFrame,
  startRawHttpFake,
  streamBody,
  userInput,
} from './fixtures.ts';
import type { RecordedHttpRequest } from './fixtures.ts';

const COMPACT_REQUEST = { model: 'default', input: userInput('hi') };
const INVALID = { status: 0, type: 'transport', code: 'invalid_response' };

const jsonReply = (status: number, body: string) => (_request: RecordedHttpRequest, response: ServerResponse) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(body);
};

const clientReplying = async (handler: (request: RecordedHttpRequest, response: ServerResponse) => void, overrides = {}) => {
  const fake = await startRawHttpFake();
  fake.respond(handler);
  const clock = fakeClock();
  return { clock, client: makeClient(fake.socketPath, clock, overrides) };
};

const IDLE_TIMEOUT_MS = 150;
const DEADLINE_MS = 400;
const PING_GAP_MS = 100;

describe('gateway client stream deadline', () => {
  it('ends a stream kept alive by pings at the run deadline with deadline_exceeded', async () => {
    const fake = await startRawHttpFake();
    let open: ServerResponse | undefined;
    fake.respond((_request, response) => {
      open = response;
      openSse(response);
      response.write(sseFrame(createdEvent));
    });
    const clock = fakeClock();
    const timers = spiedTimers(clock);
    const client = makeClient(fake.socketPath, clock, { streamIdleTimeoutMs: IDLE_TIMEOUT_MS, timers });
    const seen: unknown[] = [];
    let armedAtFirstEvent = 0;
    let firstEventSeen: () => void = () => {};
    const firstEvent = new Promise<void>((resolve) => {
      firstEventSeen = resolve;
    });
    const finished = settle(
      (async () => {
        for await (const event of client.stream(streamBody(), callOptions(clock, { deadlineInMs: DEADLINE_MS }))) {
          seen.push(event);
          armedAtFirstEvent = timers.armed();
          firstEventSeen();
        }
      })(),
    );

    await firstEvent;
    await timers.untilArmed(armedAtFirstEvent + 1);
    for (let elapsed = 0; elapsed < DEADLINE_MS; elapsed += PING_GAP_MS) {
      const armedBefore = timers.armed();
      (open as ServerResponse).write(': ping\n\n');
      await timers.untilArmed(armedBefore + 1);
      timers.advance(PING_GAP_MS);
    }
    const error = await finished;

    expect(seen).toEqual([createdEvent]);
    expectGatewayError(error, { status: 0, type: 'transport', code: 'deadline_exceeded' });
  });
});

describe('gateway client malformed replies', () => {
  it('rejects a compact reply that is not an object', async () => {
    const { clock, client } = await clientReplying(jsonReply(200, '[1,2]'));
    expectGatewayError(await settle(client.compact(COMPACT_REQUEST, callOptions(clock))), INVALID);
  });

  it('rejects a non-JSON 2xx body', async () => {
    const { clock, client } = await clientReplying((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('not json at all');
    });
    expectGatewayError(await settle(client.compact(COMPACT_REQUEST, callOptions(clock))), INVALID);
  });

  it('rejects a countTokens reply that is not an object', async () => {
    const { client } = await clientReplying(jsonReply(200, '"many"'));
    expectGatewayError(await settle(client.countTokens(COMPACT_REQUEST, { signal: new AbortController().signal })), INVALID);
  });

  it('treats a countTokens reply without error_shape as a malformed reply', async () => {
    const { client } = await clientReplying(jsonReply(200, JSON.stringify({ input_tokens: 10, method: 'estimated', error_bound: 3 })));
    const error = await settle(client.countTokens(COMPACT_REQUEST, { signal: new AbortController().signal }));
    expectGatewayError(error, INVALID);
    expect((error as Error).message).toBe('the gateway sent a malformed reply: the count_tokens reply has an error_shape without a numeric ratio and minimum');
  });

  it('rejects a health reply that is not an object', async () => {
    const { client } = await clientReplying(jsonReply(200, '[]'));
    expectGatewayError(await settle(client.health()), INVALID);
  });

  it('rejects a models reply without a data array', async () => {
    const { client } = await clientReplying(jsonReply(200, JSON.stringify({ object: 'list' })));
    expectGatewayError(await settle(client.models()), INVALID);
  });

  it('rejects a models entry without a string id', async () => {
    const { client } = await clientReplying(jsonReply(200, JSON.stringify(listingBody([{ ...listedEntry('fake/main', {}), id: 7 }]))));
    expectGatewayError(await settle(client.models()), INVALID);
  });

  it.each([
    ['without a chain', { ...listedEntry('fake/main', {}), chain: undefined }],
    ['with an empty chain', listedEntry('fake/main', {}, [])],
    ['with a chain member that has no counter', listedEntry('fake/main', {}, [listedMember('fake/main', {}), { ...listedMember('fake/small', {}), counter: undefined }])],
    ['with a counter that is not a string', listedEntry('fake/main', {}, [listedMember('fake/main', {}, 7)])],
    ['with a chain member that does not say what answers', listedEntry('fake/main', {}, [{ ...listedMember('fake/main', {}), answers: 'someone' }])],
    ['without the server name', { ...listedEntry('fake/main', {}), provider: undefined }],
    ['without its own name', { ...listedEntry('fake/main', {}), ownName: undefined }],
    ['in the shape of an earlier build', { id: 'default', targets: ['primary'], capabilities: {}, targetCapabilities: { primary: {} }, targetCounters: { primary: 'c'.repeat(64) } }],
  ])('rejects a models entry %s', async (_label, entry) => {
    const { client } = await clientReplying(jsonReply(200, JSON.stringify(listingBody([entry]))));
    expectGatewayError(await settle(client.models()), INVALID);
  });

  it('rejects a cancel reply whose cancelled is not a boolean', async () => {
    const { client } = await clientReplying(jsonReply(200, JSON.stringify({ cancelled: 'yes' })));
    expectGatewayError(await settle(client.cancel('key-1', { signal: new AbortController().signal })), INVALID);
  });

  it('rejects an SSE frame whose data is not JSON', async () => {
    const { clock, client } = await clientReplying((_request, response) => {
      openSse(response);
      response.end('event: response.created\ndata: {not json\n\n');
    });
    expectGatewayError(await settle(collect(client.stream(streamBody(), callOptions(clock)))), INVALID);
  });

  it('rejects an SSE frame whose data has no string type', async () => {
    const { clock, client } = await clientReplying((_request, response) => {
      openSse(response);
      response.end(`data: ${JSON.stringify({ type: 5, sequence_number: 0 })}\n\n`);
    });
    expectGatewayError(await settle(collect(client.stream(streamBody(), callOptions(clock)))), INVALID);
  });
});

const DEEP_LEVELS = 200;

const nested = (levels: number): string => `${'{"a":'.repeat(levels)}1${'}'.repeat(levels)}`;

const TOO_DEEP = { ...INVALID, message: expect.stringContaining('JSON depth exceeds the limit') };

describe('gateway client replies nested too deep (the one bounded parse of text from another process)', () => {
  it('refuses a unary reply nested 200 levels deep with the typed malformed-reply error', async () => {
    const { client } = await clientReplying(jsonReply(200, nested(DEEP_LEVELS)));
    expectGatewayError(await settle(client.health()), TOO_DEEP);
  });

  it('refuses a compact reply nested 200 levels deep', async () => {
    const { clock, client } = await clientReplying(jsonReply(200, nested(DEEP_LEVELS)));
    expectGatewayError(await settle(client.compact(COMPACT_REQUEST, callOptions(clock))), TOO_DEEP);
  });

  it('refuses a compact stream frame nested 200 levels deep', async () => {
    const { clock, client } = await clientReplying((_request, response) => {
      openSse(response);
      response.end(`event: response.in_progress\ndata: ${nested(DEEP_LEVELS)}\n\n`);
    });
    expectGatewayError(await settle(client.compact(COMPACT_REQUEST, callOptions(clock))), TOO_DEEP);
  });

  it('refuses a stream frame nested 200 levels deep although it has a string type', async () => {
    const { clock, client } = await clientReplying((_request, response) => {
      openSse(response);
      response.end(`data: {"type":"response.created","sequence_number":0,"response":${nested(DEEP_LEVELS)}}\n\n`);
    });
    expectGatewayError(await settle(collect(client.stream(streamBody(), callOptions(clock)))), TOO_DEEP);
  });

  it('answers an error body nested 200 levels deep by its HTTP status, without reading the body as an error', async () => {
    const body = `{"error":{"message":"taken from the body","code":"from_the_body","type":"invalid_request"},"extra":${nested(DEEP_LEVELS)}}`;
    const { client } = await clientReplying(jsonReply(400, body));
    expectGatewayError(await settle(client.health()), { status: 400, code: 'http_400' });
  });
});
