import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  callOptions,
  collect,
  createdEvent,
  expectGatewayError,
  fakeClock,
  makeClient,
  openSse,
  registerCleanup,
  settle,
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

describe('gateway client stream deadline', () => {
  it('ends a stream kept alive by pings at the run deadline with deadline_exceeded', async () => {
    const { clock, client } = await clientReplying((_request, response) => {
      openSse(response);
      response.write(sseFrame(createdEvent));
      const pings = setInterval(() => response.write(': ping\n\n'), 30);
      registerCleanup(() => clearInterval(pings));
    }, { streamIdleTimeoutMs: 150 });
    const seen: unknown[] = [];

    let guard: NodeJS.Timeout | undefined;
    const stillOpen = new Promise<string>((resolve) => {
      guard = setTimeout(() => resolve('still open after 2000 ms'), 2000);
    });
    registerCleanup(() => clearTimeout(guard));
    const error = await Promise.race([
      settle(
        (async () => {
          for await (const event of client.stream(streamBody(), callOptions(clock, { deadlineInMs: 400 }))) seen.push(event);
        })(),
      ),
      stillOpen,
    ]);

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

  it('rejects a health reply that is not an object', async () => {
    const { client } = await clientReplying(jsonReply(200, '[]'));
    expectGatewayError(await settle(client.health()), INVALID);
  });

  it('rejects a models reply without a data array', async () => {
    const { client } = await clientReplying(jsonReply(200, JSON.stringify({ object: 'list' })));
    expectGatewayError(await settle(client.models()), INVALID);
  });

  it('rejects a models entry without a string id', async () => {
    const { client } = await clientReplying(jsonReply(200, JSON.stringify({ object: 'list', data: [{ id: 7, capabilities: {} }] })));
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
