import { describe, expect, it } from 'vitest';
import type { CapabilityOverride, Capabilities, ToolCallingMode } from '@momonga/protocol';
import type { FakeChatCompletionsServer, FakeScriptedReply } from '@momonga/testkit';
import { postJson, readJson, startGateway, userInput } from './gateway-helpers.ts';
import { CC_CAPABILITIES, completionBodies, makeAdapter, readFileTool, startFake } from './cc-support.ts';
import { textReply } from './cc-compact-support.ts';

const ENVELOPE_FINAL = '{"kind":"final","text":"ok"}';

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

const withReadFile = { model: 'fast', input: userInput('please read a'), tools: [readFileTool] };

type Declaration = () => Promise<Capabilities>;

const declared = (mode: ToolCallingMode): Declaration => async () => ({ ...CC_CAPABILITIES, toolCalling: mode });

const startCc = async (options: {
  own: ToolCallingMode;
  capabilities?: Declaration;
  override?: CapabilityOverride;
  scenario: 'tools-ok' | 'json-schema-only';
  script: FakeScriptedReply[];
}): Promise<{ fake: FakeChatCompletionsServer; client: Awaited<ReturnType<typeof startGateway>>['client'] }> => {
  const fake = await startFake({ scenario: options.scenario, script: options.script });
  const adapter = makeAdapter(fake, { capabilities: options.capabilities ?? declared(options.own) });
  const { client } = await startGateway({
    adapters: { fm: adapter },
    config: { aliases: { fast: ['fm'] }, targets: { fm: { model: 'system', ...(options.override === undefined ? {} : { capabilities: options.override }) } } },
  });
  return { fake, client };
};

const expectCompleted = (response: { status: number; body: any }) => {
  expect(response.body.error).toBeNull();
  expect(response.body.status).toBe('completed');
  expect(response.status).toBe(200);
};

const countOf = async (client: Awaited<ReturnType<typeof startGateway>>['client']): Promise<number> => {
  const counted = await readJson(await postJson(client, '/v1/momonga/count_tokens', withReadFile));
  expect(counted.status).toBe(200);
  return counted.body.input_tokens;
};

describe('chat-completions takes its tool-calling mode from the router-resolved capabilities', () => {
  it('a native declaration overridden to constrained sends the constrained body and counts that body', async () => {
    const { fake, client } = await startCc({ own: 'native', override: { toolCalling: 'constrained' }, scenario: 'json-schema-only', script: [textReply(ENVELOPE_FINAL)] });
    expectCompleted(await readJson(await postJson(client, '/v1/responses', withReadFile)));
    const sent = completionBodies(fake)[0];
    expect(sent.response_format?.type).toBe('json_schema');
    expect(sent.tools).toBeUndefined();

    const constrainedReference = await startCc({ own: 'constrained', scenario: 'json-schema-only', script: [] });
    const nativeReference = await startCc({ own: 'native', scenario: 'tools-ok', script: [] });
    const constrainedCount = await countOf(constrainedReference.client);
    expect(constrainedCount).not.toBe(await countOf(nativeReference.client));
    expect(await countOf(client)).toBe(constrainedCount);
  });

  it('a native declaration overridden to none refuses a request with tools at narrowing and sends nothing', async () => {
    const { fake, client } = await startCc({ own: 'native', override: { toolCalling: 'none' }, scenario: 'tools-ok', script: [textReply('never')] });
    const response = await readJson(await postJson(client, '/v1/responses', withReadFile));
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('capability_unsupported');
    expect(response.body.error.param).toBe('tools');
    expect(completionBodies(fake)).toHaveLength(0);
  });

  it('a constrained declaration overridden to native sends the native body', async () => {
    const { fake, client } = await startCc({ own: 'constrained', override: { toolCalling: 'native' }, scenario: 'tools-ok', script: [textReply(ENVELOPE_FINAL)] });
    expectCompleted(await readJson(await postJson(client, '/v1/responses', withReadFile)));
    const sent = completionBodies(fake)[0];
    expect(listedNames(sent)).toEqual(['read_file']);
    expect(sent.response_format).toBeUndefined();
  });
});

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
  { name: 'compact', path: '/v1/responses/compact', body: { model: 'fast', input: userInput('summarise this') } },
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
    const { client } = await startGateway({ adapters: { fm: adapter }, config: { aliases: { fast: ['fm'] }, targets: { fm: { model: 'system' } } } });
    callsAtStart = declaration.calls();
    const created = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hello'), tools: TOOLS, tool_choice: TWO_AUTO }));
    expectCompleted(created);
    expect(listedNames(completionBodies(fake)[0])).toEqual(['alpha', 'beta']);
  });
});

describe('a fallback attempt carries the capabilities of the target it falls back to', () => {
  it('the second target body uses the output bound field of the second target override', async () => {
    const firstFake = await startFake({ scenario: 'tools-ok', script: [{ kind: 'error', status: 503, body: { error: { message: 'first is down' } } }] });
    const secondFake = await startFake({ scenario: 'tools-ok', script: [textReply('from second')] });
    const { client } = await startGateway({
      adapters: { first: makeAdapter(firstFake), second: makeAdapter(secondFake) },
      config: {
        aliases: { fast: ['first', 'second'] },
        targets: {
          first: { model: 'system', capabilities: { outputBoundField: 'max_tokens' } },
          second: { model: 'system', capabilities: { outputBoundField: 'max_completion_tokens' } },
        },
        retry: { maxAttempts: 1, totalWaitMs: 1 },
      },
    });
    const response = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hello'), max_output_tokens: 100 }));
    expectCompleted(response);
    expect(completionBodies(firstFake)).toHaveLength(1);
    expect(completionBodies(firstFake)[0].max_tokens).toBe(100);
    const second = completionBodies(secondFake)[0];
    expect(second.max_completion_tokens).toBe(100);
    expect(second.max_tokens).toBeUndefined();
  });
});
