import { afterEach, describe, expect, it } from 'vitest';
import {
  PLAN_ERROR_CODES,
  PLAN_UNSUPPORTED_FIELDS,
  openResponsesTextReply,
  planAdmissionReply,
  planErrorHttpReply,
  planErrorStreamReply,
  startFakePlanResponses,
} from '../src/index.ts';
import type { FakePlanResponses, PlanResponsesOptions } from '../src/index.ts';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const startPlan = async (options: Partial<PlanResponsesOptions> = {}): Promise<FakePlanResponses> => {
  const server = await startFakePlanResponses({ verifyBearer: (token) => (token === 'good' ? 'valid' : 'unknown'), ...options });
  closers.push(() => server.close());
  return server;
};

const VALID = { model: 'gpt-fake', input: [{ role: 'user', content: 'hi' }], store: false, stream: true };

const post = (server: FakePlanResponses, body: unknown, token: string | null = 'good', path = '/v1/responses'): Promise<Response> =>
  fetch(`${server.origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const events = async (response: Response): Promise<Array<{ event: string | undefined; data: string }>> =>
  (await response.text())
    .split('\n\n')
    .filter((block) => block !== '')
    .map((block) => {
      const lines = block.split('\n');
      return { event: lines.find((line) => line.startsWith('event: '))?.slice(7), data: lines.find((line) => line.startsWith('data: '))?.slice(6) ?? '' };
    });

type ErrorBody = { error: { code: string; message: string; param: string | null } };

describe('fake plan Responses route: admission', () => {
  it('listens on loopback TCP, not on a socket', async () => {
    const server = await startPlan();
    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it.each([
    ['no bearer', null],
    ['an unknown bearer', 'nope'],
  ])('answers 401 with a detail body for %s, and spends no scripted reply', async (_name, token) => {
    const server = await startPlan({ script: [openResponsesTextReply(['a'])] });
    const response = await post(server, VALID, token);
    expect(response.status).toBe(401);
    expect(Object.keys((await response.json()) as object)).toEqual(['detail']);
    expect((await post(server, VALID)).status).toBe(200);
  });

  it('asks the verifier about the bearer and refuses an expired and a revoked one', async () => {
    const verdicts: Record<string, 'valid' | 'expired' | 'revoked' | 'unknown'> = { fresh: 'valid', old: 'expired', gone: 'revoked' };
    const server = await startPlan({ verifyBearer: (token) => verdicts[token ?? ''] ?? 'unknown', script: [openResponsesTextReply(['a'])] });
    expect((await post(server, VALID, 'old')).status).toBe(401);
    expect((await post(server, VALID, 'gone')).status).toBe(401);
    expect((await post(server, VALID, 'fresh')).status).toBe(200);
  });

  it('answers a request to another method or endpoint with route_not_supported', async () => {
    const server = await startPlan();
    const wrongPath = await post(server, VALID, 'good', '/v1/chat/completions');
    expect(wrongPath.status).toBe(403);
    expect(((await wrongPath.json()) as ErrorBody).error.code).toBe('subscription_sharing_route_not_supported');
    const wrongMethod = await fetch(`${server.origin}/v1/responses`, { headers: { authorization: 'Bearer good' } });
    expect(wrongMethod.status).toBe(403);
    expect(((await wrongMethod.json()) as ErrorBody).error.code).toBe('subscription_sharing_route_not_supported');
  });
});

describe('fake plan Responses route: what the preview rejects', () => {
  const rejected = async (body: unknown): Promise<ErrorBody['error']> => {
    const server = await startPlan({ script: [openResponsesTextReply(['a'])] });
    const response = await post(server, body);
    expect(response.status).toBe(400);
    const { error } = (await response.json()) as ErrorBody;
    expect(error.code).toBe('subscription_sharing_unsupported_capability');
    return error;
  };

  it.each(PLAN_UNSUPPORTED_FIELDS.map((field) => [field]))('rejects the field %s and names it in error.param', async (field) => {
    expect((await rejected({ ...VALID, [field]: field === 'user' ? 'u' : 1 })).param).toBe(field);
  });

  it('rejects previous_response_id, store other than false and stream other than true', async () => {
    expect((await rejected({ ...VALID, previous_response_id: 'resp_1' })).param).toBe('previous_response_id');
    expect((await rejected({ ...VALID, store: true })).param).toBe('store');
    expect((await rejected({ ...VALID, stream: false })).param).toBe('stream');
    const { store: _store, ...withoutStore } = VALID;
    expect((await rejected(withoutStore)).param).toBe('store');
  });

  it('rejects an explicit system item and accepts instructions and developer items', async () => {
    expect((await rejected({ ...VALID, input: [{ type: 'message', role: 'system', content: 'be brief' }] })).param).toBe('input');
    const server = await startPlan({ script: [openResponsesTextReply(['a']), openResponsesTextReply(['b'])] });
    expect((await post(server, { ...VALID, instructions: 'be brief' })).status).toBe(200);
    expect((await post(server, { ...VALID, input: [{ type: 'message', role: 'developer', content: 'be brief' }, { role: 'user', content: 'hi' }] })).status).toBe(200);
  });

  it.each(['image_generation', 'file_search', 'code_interpreter', 'computer_use_preview', 'mcp', 'tool_search'])('rejects the hosted tool %s in tools', async (type) => {
    expect((await rejected({ ...VALID, tools: [{ type }] })).param).toBe('tools');
  });

  it('rejects programmatic_tool_calling in top-level tools, and accepts function tools and additional_tools items', async () => {
    expect((await rejected({ ...VALID, tools: [{ type: 'function', name: 'f', parameters: {}, programmatic_tool_calling: true }] })).param).toBe('tools');
    const server = await startPlan({ script: [openResponsesTextReply(['a']), openResponsesTextReply(['b'])] });
    expect((await post(server, { ...VALID, tools: [{ type: 'function', name: 'f', parameters: {} }] })).status).toBe(200);
    const withAdditional = { ...VALID, input: [{ type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 'f', parameters: {} }] }, ...VALID.input] };
    expect((await post(server, withAdditional)).status).toBe(200);
  });

  it.each(['input_audio', 'input_video'])('rejects %s content in input', async (type) => {
    expect((await rejected({ ...VALID, input: [{ role: 'user', content: [{ type }] }] })).param).toBe('input');
  });

  it('accepts text, image and file input', async () => {
    const server = await startPlan({ script: [openResponsesTextReply(['a'])] });
    const content = [{ type: 'input_text', text: 't' }, { type: 'input_image', image_url: 'data:image/png;base64,AA==' }, { type: 'input_file', file_id: 'f' }];
    expect((await post(server, { ...VALID, input: [{ role: 'user', content }] })).status).toBe(200);
  });

  it('rejects a body that is not JSON as a bad request, not as a capability gap', async () => {
    const server = await startPlan();
    expect((await post(server, '{not json')).status).toBe(400);
  });

  it('rejects a body above the configured size with the configured reply and passes one below it', async () => {
    const server = await startPlan({
      script: [openResponsesTextReply(['a'])],
      maxRequestBytes: { limit: 400, reply: { kind: 'error', status: 413, body: { error: { code: 'configured_by_the_test', message: 'too large', param: null } } } },
    });
    const large = await post(server, { ...VALID, instructions: 'x'.repeat(500) });
    expect(large.status).toBe(413);
    expect(((await large.json()) as ErrorBody).error.code).toBe('configured_by_the_test');
    expect((await post(server, VALID)).status).toBe(200);
    expect(server.requests.at(-1)?.path).toBe('/v1/responses');
  });
});

describe('fake plan Responses route: scripted errors', () => {
  it('plays every catalogued code as an HTTP error with its documented status, error.code and error.param', async () => {
    for (const entry of PLAN_ERROR_CODES) {
      const status = entry.status ?? 429;
      const server = await startPlan({ script: [planErrorHttpReply(entry.code, { status, param: 'tools' })] });
      const response = await post(server, VALID);
      expect(response.status, entry.code).toBe(status);
      const { error } = (await response.json()) as ErrorBody;
      expect(error.code).toBe(entry.code);
      expect(error.param).toBe('tools');
      expect(typeof error.message).toBe('string');
    }
  });

  it('plays every catalogued code as response.failed after the stream has begun', async () => {
    for (const entry of PLAN_ERROR_CODES) {
      const server = await startPlan({ script: [planErrorStreamReply(entry.code, { message: 'limit' })] });
      const response = await post(server, VALID);
      expect(response.status, entry.code).toBe(200);
      const frames = await events(response);
      expect(frames[0]?.event).toBe('response.created');
      const failed = frames.find((frame) => frame.event === 'response.failed');
      expect(failed, entry.code).toBeDefined();
      const body = JSON.parse(failed?.data ?? '{}') as { response: { status: string; error: { code: string; message: string } } };
      expect(body.response.status).toBe('failed');
      expect(body.response.error.code).toBe(entry.code);
      expect(frames.some((frame) => frame.event === 'response.completed')).toBe(false);
    }
  });

  it('carries headers such as Retry-After on an HTTP error', async () => {
    const server = await startPlan({ script: [planErrorHttpReply('subscription_sharing_usage_limit_exceeded', { headers: { 'retry-after': '120' } })] });
    const response = await post(server, VALID);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('120');
  });

  it('refuses to play a code whose status the pages do not state unless the test gives one', () => {
    const piOnly = PLAN_ERROR_CODES.find((entry) => entry.status === null);
    expect(piOnly?.code).toBe('subscription_sharing_workplace_individual_usage_limit_exceeded');
    expect(() => planErrorHttpReply(piOnly?.code ?? '', {})).toThrow(/status/);
    expect(planErrorHttpReply(piOnly?.code ?? '', { status: 429 })).toMatchObject({ kind: 'error', status: 429 });
  });

  it('refuses to play a code outside the catalogue', () => {
    expect(() => planErrorHttpReply('made_up_code', {})).toThrow(/catalogue/);
    expect(() => planErrorStreamReply('made_up_code', {})).toThrow(/catalogue/);
  });

  it.each([401, 403, 503])('plays the admission failure %i as a detail body with no error object', async (status) => {
    const server = await startPlan({ script: [planAdmissionReply(status, 'diagnostic text')] });
    const response = await post(server, VALID);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ detail: 'diagnostic text' });
  });

  it('answers 500 when the script is exhausted, like the other fakes', async () => {
    const server = await startPlan();
    expect((await post(server, VALID)).status).toBe(500);
  });

  it('computes a reply from the recorded request when given respond instead of a script', async () => {
    const server = await startPlan({ respond: (request) => openResponsesTextReply([JSON.stringify((request.body as { model: string }).model)]) });
    const frames = await events(await post(server, VALID));
    expect(frames.some((frame) => frame.data.includes('gpt-fake'))).toBe(true);
  });
});

describe('fake plan Responses route: the model list', () => {
  const models = [
    { slug: 'gpt-fake', display_name: 'GPT Fake', visibility: 'list', context_window: 272000 },
    { slug: 'gpt-hidden', display_name: 'Hidden', visibility: 'hide', context_window: 1000 },
  ];

  it('serves a models array on GET /v1/models to a valid bearer', async () => {
    const server = await startPlan({ models });
    const response = await fetch(`${server.origin}/v1/models`, { headers: { authorization: 'Bearer good' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ models });
    expect(server.requests.at(-1)).toMatchObject({ method: 'GET', path: '/v1/models' });
  });

  it('refuses the list to a bearer that is not valid', async () => {
    const server = await startPlan({ models });
    const response = await fetch(`${server.origin}/v1/models`, { headers: { authorization: 'Bearer nope' } });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ detail: expect.any(String) });
  });

  it('serves an empty array when it was given none', async () => {
    const server = await startPlan();
    const response = await fetch(`${server.origin}/v1/models`, { headers: { authorization: 'Bearer good' } });
    expect(await response.json()).toEqual({ models: [] });
  });
});
