import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { GatewayRequestError } from '@momonga/runtime';
import { callOptions, collect, fakeClock, makeClient, openSse, settle, startRawHttpFake, streamBody } from './fixtures.ts';
import type { RecordedHttpRequest } from './fixtures.ts';

const PLAN = { profile: 'chatgpt', account: 'work' };
const USAGE_ERROR = { type: 'too_many_requests', code: 'plan_usage_limit', message: 'Manage usage.', param: null };

const clientReplying = async (handler: (request: RecordedHttpRequest, response: ServerResponse) => void) => {
  const fake = await startRawHttpFake();
  fake.respond(handler);
  const clock = fakeClock();
  return { clock, client: makeClient(fake.socketPath, clock) };
};

const unaryReply = (error: Record<string, unknown>) => (_request: RecordedHttpRequest, response: ServerResponse) => {
  response.writeHead(429, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error }));
};

const cancelFailure = async (error: Record<string, unknown>): Promise<unknown> => {
  const { client } = await clientReplying(unaryReply(error));
  return settle(client.cancel('k', { signal: new AbortController().signal }));
};

describe('a gateway error carries the plan account of the failing target to the runtime', () => {
  it('a unary error body with plan gives a GatewayRequestError with plan', async () => {
    const failure = await cancelFailure({ ...USAGE_ERROR, plan: PLAN });
    expect(failure).toBeInstanceOf(GatewayRequestError);
    expect((failure as GatewayRequestError & { plan?: unknown }).plan).toEqual(PLAN);
  });

  it('an SSE error event with plan gives the same', async () => {
    const frame = `data: ${JSON.stringify({ type: 'error', sequence_number: 0, status: 429, error: { ...USAGE_ERROR, plan: PLAN } })}\n\n`;
    const { clock, client } = await clientReplying((_request, response) => {
      openSse(response);
      response.end(frame);
    });
    const failure = await settle(collect(client.stream(streamBody(), callOptions(clock))));
    expect(failure).toBeInstanceOf(GatewayRequestError);
    expect((failure as GatewayRequestError & { plan?: unknown }).plan).toEqual(PLAN);
  });

  it('a plan with a profile and no account is kept as the profile alone', async () => {
    const failure = await cancelFailure({ ...USAGE_ERROR, plan: { profile: 'chatgpt' } });
    expect(failure).toBeInstanceOf(GatewayRequestError);
    expect((failure as GatewayRequestError & { plan?: unknown }).plan).toEqual({ profile: 'chatgpt' });
  });

  it.each([
    ['an account that is not a label', { profile: 'chatgpt', account: 'not a label' }],
    ['no profile', { account: 'work' }],
    ['a profile that is not a label', { profile: '', account: 'work' }],
  ])('a malformed plan (%s) is dropped and the code, message and type are kept', async (_name, plan) => {
    const failure = await cancelFailure({ ...USAGE_ERROR, plan });
    expect(failure).toBeInstanceOf(GatewayRequestError);
    expect(failure).toMatchObject({ status: 429, type: 'too_many_requests', code: 'plan_usage_limit', message: 'Manage usage.' });
    expect('plan' in (failure as object)).toBe(false);
  });

  it('a body without plan has no plan key', async () => {
    const failure = await cancelFailure(USAGE_ERROR);
    expect(failure).toMatchObject({ code: 'plan_usage_limit' });
    expect('plan' in (failure as object)).toBe(false);
  });
});
