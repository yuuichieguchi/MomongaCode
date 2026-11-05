import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Capabilities } from '@momonga/protocol';
import { anthropicCountTokensReply, anthropicTextReply, openResponsesTextReply } from '@momonga/testkit';
import { postJson, readJson, startGateway, userInput } from './gateway-helpers.ts';
import { CC_CAPABILITIES, completionBodies, makeAdapter, startFake } from './cc-support.ts';
import { OLLAMA_CAPABILITIES, chunkLine, doneLine, makeOllamaAdapter, startFakeOllama } from './ollama-support.ts';
import { REMOTE_CAPABILITIES, startAnthropicGateway, startOpenResponsesGateway } from './upstream-gateway-support.ts';

const toolNamed = (name: string) => ({
  type: 'function' as const,
  name,
  description: `the ${name} tool`,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
});

const TOOLS = [toolNamed('alpha'), toolNamed('beta'), toolNamed('gamma')];
const SUBSET_TOOLS = [toolNamed('alpha'), toolNamed('beta')];

const TWO_AUTO = {
  type: 'allowed_tools' as const,
  mode: 'auto' as const,
  tools: [
    { type: 'function' as const, name: 'alpha' },
    { type: 'function' as const, name: 'beta' },
  ],
};

const FILTER_OVERRIDE = { allowedTools: ['filter' as const] };

const withoutAllowedTools = (capabilities: Capabilities): Capabilities => {
  const { allowedTools: _dropped, ...rest } = capabilities;
  return rest;
};

const requestBody = (tools: unknown, toolChoice: unknown) => ({ model: 'fast', input: userInput('hello'), tools, tool_choice: toolChoice });

const listedNames = (body: any): string[] => (body?.tools ?? []).map((tool: any) => tool.function?.name ?? tool.name);

const systemText = (body: any): string =>
  (body?.messages ?? []).filter((message: any) => message.role === 'system').map((message: any) => message.content).join('\n');

const remoteConfig = { aliases: { fast: ['remote'] }, targets: { remote: { model: 'upstream-model', kind: 'remote', capabilities: FILTER_OVERRIDE } } };

const expectCountedAsSubset = async (client: Parameters<typeof postJson>[0]) => {
  const filtered = await readJson(await postJson(client, '/v1/momonga/count_tokens', requestBody(TOOLS, TWO_AUTO)));
  const subset = await readJson(await postJson(client, '/v1/momonga/count_tokens', requestBody(SUBSET_TOOLS, 'auto')));
  expect(filtered.status).toBe(200);
  expect(subset.status).toBe(200);
  expect(filtered.body.input_tokens).toBe(subset.body.input_tokens);
};

describe('a probe-derived override reaches the send path as it reaches the count path', () => {
  it('anthropic: create and count_tokens send the same tools and tool_choice, both filtered as the router resolves', async () => {
    const own = withoutAllowedTools(REMOTE_CAPABILITIES);
    const creating = await startAnthropicGateway({ capabilities: own, config: remoteConfig, script: [anthropicTextReply(['ok'])] });
    const counting = await startAnthropicGateway({ capabilities: own, config: remoteConfig, script: [anthropicCountTokensReply(42)] });
    const created = await readJson(await postJson(creating.client, '/v1/responses', requestBody(TOOLS, TWO_AUTO)));
    const counted = await readJson(await postJson(counting.client, '/v1/momonga/count_tokens', requestBody(TOOLS, TWO_AUTO)));
    expect(counted.status).toBe(200);
    const count = counting.fake.requests[0]?.body as any;
    expect(listedNames(count)).toEqual(['alpha', 'beta']);
    expect(created.body.error).toBeNull();
    expect(created.body.status).toBe('completed');
    expect(created.status).toBe(200);
    const sent = creating.fake.requests[0]?.body as any;
    expect(listedNames(sent)).toEqual(['alpha', 'beta']);
    expect(count.tools).toEqual(sent.tools);
    expect(count.tool_choice).toEqual(sent.tool_choice);
  });

  it('open-responses: create sends the filtered tools and count_tokens counts the same tools', async () => {
    const gateway = await startOpenResponsesGateway({ capabilities: withoutAllowedTools(REMOTE_CAPABILITIES), config: remoteConfig, script: [openResponsesTextReply(['ok'])] });
    await expectCountedAsSubset(gateway.client);
    const created = await readJson(await postJson(gateway.client, '/v1/responses', requestBody(TOOLS, TWO_AUTO)));
    expect(created.body.error).toBeNull();
    expect(created.body.status).toBe('completed');
    expect(created.status).toBe(200);
    expect(listedNames(gateway.fake.requests[0]?.body)).toEqual(['alpha', 'beta']);
  });

  it('ollama: create sends the filtered tools and count_tokens counts the same tools', async () => {
    const fake = await startFakeOllama({ chat: [{ kind: 'ndjson' as const, lines: [chunkLine({ content: 'ok' }), doneLine()] }] });
    const adapter = makeOllamaAdapter(fake, { capabilities: async () => withoutAllowedTools(OLLAMA_CAPABILITIES) });
    const gateway = await startGateway({
      adapters: { local: adapter },
      config: { aliases: { fast: ['local'] }, targets: { local: { model: 'devstral-small-2', kind: 'local', capabilities: FILTER_OVERRIDE } } },
    });
    await expectCountedAsSubset(gateway.client);
    const created = await readJson(await postJson(gateway.client, '/v1/responses', requestBody(TOOLS, TWO_AUTO)));
    expect(created.body.error).toBeNull();
    expect(created.body.status).toBe('completed');
    expect(created.status).toBe(200);
    expect(listedNames(fake.chatBodies()[0])).toEqual(['alpha', 'beta']);
  });

  const startCcGateway = async (toolCalling: 'native' | 'constrained', scenario: 'tools-ok' | 'json-schema-only', reply: string) => {
    const fake = await startFake({
      scenario,
      script: [{ kind: 'stream' as const, chunks: [{ delta: { role: 'assistant' as const, content: reply } }, { delta: {}, finishReason: 'stop' as const }] }],
    });
    const adapter = makeAdapter(fake, { toolCalling: () => toolCalling, capabilities: async () => withoutAllowedTools({ ...CC_CAPABILITIES, toolCalling }) });
    const gateway = await startGateway({
      adapters: { fm: adapter },
      config: { aliases: { fast: ['fm'] }, targets: { fm: { model: 'system', capabilities: FILTER_OVERRIDE } } },
    });
    return { fake, gateway };
  };

  it('chat-completions native: create sends the filtered tools and count_tokens counts the same tools', async () => {
    const { fake, gateway } = await startCcGateway('native', 'tools-ok', 'ok');
    await expectCountedAsSubset(gateway.client);
    const created = await readJson(await postJson(gateway.client, '/v1/responses', requestBody(TOOLS, TWO_AUTO)));
    expect(created.body.error).toBeNull();
    expect(created.body.status).toBe('completed');
    expect(created.status).toBe(200);
    expect(listedNames(completionBodies(fake)[0])).toEqual(['alpha', 'beta']);
  });

  it('chat-completions constrained: create offers only the filtered tools and count_tokens counts the same tools', async () => {
    const { fake, gateway } = await startCcGateway('constrained', 'json-schema-only', '{"kind":"final","text":"ok"}');
    await expectCountedAsSubset(gateway.client);
    const created = await readJson(await postJson(gateway.client, '/v1/responses', requestBody(TOOLS, TWO_AUTO)));
    expect(created.body.error).toBeNull();
    expect(created.body.status).toBe('completed');
    expect(created.status).toBe(200);
    const sent = systemText(completionBodies(fake)[0]);
    expect(sent).toContain('"name":"alpha"');
    expect(sent).toContain('"name":"beta"');
    expect(sent).not.toContain('"name":"gamma"');
  });
});

const adaptersDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'adapters');

const sourcesUnder = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourcesUnder(full);
    return /\.tsx?$/.test(entry.name) ? [path.relative(adaptersDir, full)] : [];
  });

const CAPABILITIES_DELEGATION = /capabilities: \(target(?:: AdapterTarget)?\) => options\.capabilities\(target\)/g;
const CAPABILITIES_METHOD_BLOCK = /\n(\s*)capabilities: async \(target(?:: AdapterTarget)?\) => \{\n[\s\S]*?\n\1\},?\n/g;
const OWN_CAPABILITIES_READ =
  /\boptions\s*(\.|\[['"])capabilities\b|\{[^}]*\bcapabilities\b[^}]*\}\s*=\s*options\b|\boptions\s*(\.|\[['"])toolCalling\b|\{[^}]*\btoolCalling\b[^}]*\}\s*=\s*options\b/;

const sendAndCountSourceOf = (relative: string): string =>
  fs.readFileSync(path.join(adaptersDir, relative), 'utf8').replace(CAPABILITIES_DELEGATION, '').replace(CAPABILITIES_METHOD_BLOCK, '\n');

describe('compaction follows the capabilities the router resolves', () => {
  const BUDGET_REASONING = { control: 'thinking' as const, form: 'budget' as const, budgets: { low: 2048 } };

  const compactedSummaryBody = async (own: Capabilities, override: Record<string, unknown> | undefined) => {
    const target = { model: 'upstream-model', kind: 'remote', ...(override === undefined ? {} : { capabilities: override }) };
    const gateway = await startAnthropicGateway({
      capabilities: own,
      config: { aliases: { fast: ['remote'] }, targets: { remote: target } },
      script: [anthropicCountTokensReply(10), anthropicTextReply(['summary'])],
    });
    const compacted = await readJson(await postJson(gateway.client, '/v1/responses/compact', { model: 'fast', input: userInput('do X') }));
    expect(compacted.status).toBe(200);
    return gateway.fake.requests.filter((request) => request.path === '/v1/messages').at(-1)?.body as any;
  };

  it('anthropic: a thinking form set only by the override reaches the summary request as if the adapter declared it', async () => {
    const declared = await compactedSummaryBody({ ...withoutAllowedTools(REMOTE_CAPABILITIES), reasoning: BUDGET_REASONING }, undefined);
    expect(declared.thinking).toBeDefined();
    const overridden = await compactedSummaryBody(withoutAllowedTools(REMOTE_CAPABILITIES), { reasoning: BUDGET_REASONING });
    expect(overridden.thinking).toEqual(declared.thinking);
    expect(overridden.max_tokens).toBe(declared.max_tokens);
  });
});

describe('adapters never read their own capabilities option on the send or count path', () => {
  const files = sourcesUnder(adaptersDir);

  it('scans the adapter sources that send upstream', () => {
    expect(files).toEqual(expect.arrayContaining(['anthropic/adapter.ts', 'chat-completions/adapter.ts', 'ollama/adapter.ts', 'open-responses/adapter.ts']));
  });

  it.for([
    'const capabilities = await options.capabilities(ctx.target);',
    "const capabilities = await options['capabilities'](ctx.target);",
    'const read = options.capabilities;',
    'const { capabilities } = options;',
    'const mode = options.toolCalling(target);',
    "const mode = options['toolCalling'](target);",
    'const { toolCalling, clock } = options;',
  ])('the guard flags %s', (line) => {
    expect(line).toMatch(OWN_CAPABILITIES_READ);
  });

  it('the guard keeps the one delegation that answers the adapter capabilities() method', () => {
    expect('    capabilities: (target) => options.capabilities(target),\n'.replace(CAPABILITIES_DELEGATION, '')).not.toMatch(OWN_CAPABILITIES_READ);
  });

  it.for(files)('%s reads capabilities only from the adapter context', (relative) => {
    const ownReads = sendAndCountSourceOf(relative)
      .split('\n')
      .filter((line) => OWN_CAPABILITIES_READ.test(line))
      .map((line) => line.trim());
    expect(ownReads).toEqual([]);
  });
});
