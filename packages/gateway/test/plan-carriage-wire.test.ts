import { describe, expect, it } from 'vitest';
import { createOpenResponsesAdapter, unauthenticatedSource } from '@momonga/gateway';
import type { Capabilities } from '@momonga/protocol';
import { PLAN_RESPONSES_PATH, UNCONFIGURED_NETWORK, UNDICI_DEFAULT_LIVENESS, createFakeClock, openResponsesTextReply, startFakePlanResponses } from '@momonga/testkit';
import type { FakePlanResponses } from '@momonga/testkit';
import { START_MS, postJson, readJson, registerCleanup, startGateway } from './gateway-helpers.ts';
import { REMOTE_CAPABILITIES, readFileTool } from './upstream-gateway-support.ts';

const PLAN_ROUTE_CAPABILITIES: Capabilities = {
  ...REMOTE_CAPABILITIES,
  sampling: { accepts: 'none' },
  outputBoundField: 'none',
  systemRole: 'developer',
  toolPlacement: 'additional_tools',
  inputKinds: { content: ['file'], tools: ['function', 'custom'] },
};

const SYSTEM_TEXT = 'You are a careful coding agent.';

const conversation = [
  { type: 'message', role: 'system', content: [{ type: 'input_text', text: SYSTEM_TEXT }] },
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
];

const startPlanRoute = async (capabilities: Capabilities): Promise<{ fake: FakePlanResponses; post: (body: Record<string, unknown>) => Promise<{ status: number; body: any }> }> => {
  const fake = await startFakePlanResponses({ verifyBearer: () => 'valid', script: [openResponsesTextReply(['ok'])] });
  registerCleanup(() => fake.close());
  const adapter = createOpenResponsesAdapter({ authSource: unauthenticatedSource,
    liveness: UNDICI_DEFAULT_LIVENESS,
    resolveEndpoint: async () => ({ kind: 'tcp', baseUrl: `${fake.origin}/v1`, network: UNCONFIGURED_NETWORK }),
    capabilities: async () => capabilities,
    clock: createFakeClock(START_MS),
  });
  registerCleanup(() => adapter.close());
  const harness = await startGateway({ adapters: { plan: adapter }, config: { aliases: { fast: ['plan'] }, targets: { plan: { model: 'plan-model' } } } });
  return { fake, post: async (body) => readJson(await postJson(harness.client, '/v1/responses', { model: 'fast', ...body })) };
};

const sentBody = (fake: FakePlanResponses): Record<string, any> => {
  const posts = fake.requests.filter((request) => request.method === 'POST' && request.path === PLAN_RESPONSES_PATH);
  expect(posts).toHaveLength(1);
  return posts[0]?.body as Record<string, any>;
};

describe('the open-responses adapter renders the instruction role a target declares (P2 item 5, I-K2)', () => {
  it('renders a system item as a developer item on a target whose systemRole is developer, and the plan route accepts it', async () => {
    const route = await startPlanRoute(PLAN_ROUTE_CAPABILITIES);
    const response = await route.post({ input: conversation });
    expect(response.status).toBe(200);
    const body = sentBody(route.fake);
    const messages = (body['input'] as Array<Record<string, unknown>>).filter((item) => item['type'] === 'message');
    expect(messages.map((item) => item['role'])).toEqual(['developer', 'user']);
    expect(messages[0]?.['content']).toEqual([{ type: 'input_text', text: SYSTEM_TEXT }]);
  });
});

describe('the open-responses adapter renders tools in the placement a target declares (P2 item 8, I-K2)', () => {
  it('sends the function tools as the first input item of type additional_tools with role developer, and no top-level tools', async () => {
    const route = await startPlanRoute(PLAN_ROUTE_CAPABILITIES);
    const response = await route.post({ input: conversation, tools: [readFileTool] });
    expect(response.status).toBe(200);
    const body = sentBody(route.fake);
    expect(body).not.toHaveProperty('tools');
    const input = body['input'] as Array<Record<string, any>>;
    expect(input[0]?.['type']).toBe('additional_tools');
    expect(input[0]?.['role']).toBe('developer');
    expect(input[0]?.['tools']).toHaveLength(1);
    expect(input[0]?.['tools'][0]).toMatchObject({ type: 'function', name: readFileTool.name });
    expect(input.filter((item) => item['type'] === 'additional_tools')).toHaveLength(1);
    expect(input.slice(1).map((item) => item['role'])).toEqual(['developer', 'user']);
  });

  it('keeps top-level tools and the system role for a target that declares neither', async () => {
    const route = await startPlanRoute({ ...REMOTE_CAPABILITIES, outputBoundField: 'none', systemRole: 'system', toolPlacement: 'top_level' });
    await route.post({ input: conversation.slice(1), tools: [readFileTool] });
    const body = sentBody(route.fake);
    expect(body['tools']).toHaveLength(1);
    expect((body['input'] as Array<Record<string, unknown>>).some((item) => item['type'] === 'additional_tools')).toBe(false);

    const systemRoute = await startPlanRoute({ ...REMOTE_CAPABILITIES, outputBoundField: 'none', systemRole: 'developer', toolPlacement: 'top_level' });
    const answered = await systemRoute.post({ input: conversation });
    expect(answered.status).toBe(200);
  });
});
