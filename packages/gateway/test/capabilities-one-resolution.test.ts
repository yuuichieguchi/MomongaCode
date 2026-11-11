import { describe, expect, it } from 'vitest';
import type { Capabilities, ToolCallingMode } from '@momonga/protocol';
import type { FakeChatCompletionsServer, FakeScriptedReply } from '@momonga/testkit';
import { postJson, readJson, startGateway, userInput } from './gateway-helpers.ts';
import { CC_CAPABILITIES, completionBodies, makeAdapter, readFileTool, startFake } from './cc-support.ts';
import { textReply } from './cc-compact-support.ts';

const toolNamed = (name: string) => ({
  type: 'function' as const,
  name,
  description: `the ${name} tool`,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
});

const TOOLS = [toolNamed('alpha'), toolNamed('beta'), toolNamed('gamma')];

const TWO_AUTO = {
  type: 'allowed_tools' as const,
  mode: 'auto' as const,
  tools: [
    { type: 'function' as const, name: 'alpha' },
    { type: 'function' as const, name: 'beta' },
  ],
};

const listedNames = (body: any): string[] => (body?.tools ?? []).map((tool: any) => tool.function?.name ?? tool.name);

const withReadFile = { model: 'scripted/system', input: userInput('please read a'), tools: [readFileTool] };

type Declaration = () => Promise<Capabilities>;

const declared = (mode: ToolCallingMode): Declaration => async () => ({ ...CC_CAPABILITIES, toolCalling: mode });

const startCc = async (options: {
  own: ToolCallingMode;
  capabilities?: Declaration;
  scenario: 'tools-ok' | 'json-schema-only';
  script: FakeScriptedReply[];
}): Promise<{ fake: FakeChatCompletionsServer; client: Awaited<ReturnType<typeof startGateway>>['client'] }> => {
  const fake = await startFake({ scenario: options.scenario, script: options.script });
  const adapter = makeAdapter(fake, { capabilities: options.capabilities ?? declared(options.own) });
  const { client } = await startGateway({
    adapters: { 'scripted/system': adapter },
    config: { chains: { 'scripted/system': ['scripted/system'] }, targets: { 'scripted/system': {} } },
  });
  return { fake, client };
};

const expectCompleted = (response: { status: number; body: any }) => {
  expect(response.body.error).toBeNull();
  expect(response.body.status).toBe('completed');
  expect(response.status).toBe(200);
};

const countingDeclaration = (answers: (call: number) => Capabilities) => {
  let calls = 0;
  const capabilities: Declaration = async () => {
    calls += 1;
    return answers(calls);
  };
  return { capabilities, calls: () => calls };
};

const OPERATIONS = [
  { name: 'create', path: '/v1/responses', body: withReadFile },
  { name: 'count_tokens', path: '/v1/momonga/count_tokens', body: withReadFile },
  { name: 'compact', path: '/v1/responses/compact', body: { model: 'scripted/system', input: userInput('summarise this') } },
];

describe('a request resolves the capabilities of each target it tries exactly once', () => {
  it.for(OPERATIONS)('$name asks the target adapter for its capabilities once', async (operation) => {
    const declaration = countingDeclaration(() => ({ ...CC_CAPABILITIES, toolCalling: 'native' }));
    const { client } = await startCc({ own: 'native', capabilities: declaration.capabilities, scenario: 'tools-ok', script: [textReply('summary')] });
    const before = declaration.calls();
    const response = await readJson(await postJson(client, operation.path, operation.body));
    expect(response.status).toBe(200);
    expect(declaration.calls() - before).toBe(1);
  });

  it.for(OPERATIONS)('$name succeeds when the adapter declaration throws after the router has resolved it once', async (operation) => {
    let started = false;
    let resolvedDuringRequest = 0;
    const capabilities: Declaration = async () => {
      if (started) {
        resolvedDuringRequest += 1;
        if (resolvedDuringRequest > 1) throw new Error('the adapter read its own capabilities a second time');
      }
      return { ...CC_CAPABILITIES, toolCalling: 'native' };
    };
    const { client } = await startCc({ own: 'native', capabilities, scenario: 'tools-ok', script: [textReply('summary')] });
    started = true;
    const response = await readJson(await postJson(client, operation.path, operation.body));
    expect(response.body.error ?? null).toBeNull();
    expect(response.status).toBe(200);
  });

  it('a declaration that changes after the first resolution does not split narrowing from send', async () => {
    let callsAtStart = Number.POSITIVE_INFINITY;
    const declaration = countingDeclaration((call) =>
      call <= callsAtStart + 1 ? { ...CC_CAPABILITIES, toolCalling: 'native', allowedTools: ['filter'] } : { ...CC_CAPABILITIES, toolCalling: 'native' },
    );
    const fake = await startFake({ scenario: 'tools-ok', script: [textReply('ok')] });
    const adapter = makeAdapter(fake, { capabilities: declaration.capabilities });
    const { client } = await startGateway({ adapters: { 'scripted/system': adapter }, config: { chains: { 'scripted/system': ['scripted/system'] }, targets: { 'scripted/system': {} } } });
    callsAtStart = declaration.calls();
    const created = await readJson(await postJson(client, '/v1/responses', { model: 'scripted/system', input: userInput('hello'), tools: TOOLS, tool_choice: TWO_AUTO }));
    expectCompleted(created);
    expect(listedNames(completionBodies(fake)[0])).toEqual(['alpha', 'beta']);
  });
});

describe('a fallback attempt carries the capabilities of the target it falls back to', () => {
  it('the second target body uses the output bound field the second target declares', async () => {
    const firstFake = await startFake({ scenario: 'tools-ok', script: [{ kind: 'error', status: 503, body: { error: { message: 'first is down' } } }] });
    const secondFake = await startFake({ scenario: 'tools-ok', script: [textReply('from second')] });
    const { client } = await startGateway({
      adapters: {
        'first/system': makeAdapter(firstFake, { capabilities: async () => ({ ...CC_CAPABILITIES, toolCalling: 'native', outputBoundField: 'max_tokens' }) }),
        'second/system': makeAdapter(secondFake, { capabilities: async () => ({ ...CC_CAPABILITIES, toolCalling: 'native', outputBoundField: 'max_completion_tokens' }) }),
      },
      config: {
        chains: { 'first/system': ['first/system', 'second/system'] },
        targets: { 'first/system': {}, 'second/system': {} },
        retry: { maxAttempts: 1, totalWaitMs: 1 },
      },
    });
    const response = await readJson(await postJson(client, '/v1/responses', { model: 'first/system', input: userInput('hello'), max_output_tokens: 100 }));
    expectCompleted(response);
    expect(completionBodies(firstFake)).toHaveLength(1);
    expect(completionBodies(firstFake)[0].max_tokens).toBe(100);
    const second = completionBodies(secondFake)[0];
    expect(second.max_completion_tokens).toBe(100);
    expect(second.max_tokens).toBeUndefined();
  });
});
