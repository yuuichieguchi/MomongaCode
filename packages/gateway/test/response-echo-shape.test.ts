import { describe, expect, it } from 'vitest';
import { anthropicTextReply, openResponsesTextReply } from '@momonga/testkit';
import { postJson, readJson, userInput, validator } from './gateway-helpers.ts';
import { startAnthropicGateway, startOpenResponsesGateway, streamResponse, terminalOf } from './upstream-gateway-support.ts';
import type { UpstreamGateway } from './upstream-gateway-support.ts';

type EchoCase = { name: string; request: Record<string, unknown>; field: 'reasoning' | 'text' | 'tools'; echoed: unknown };

const cases: EchoCase[] = [
  { name: 'reasoning with effort only', request: { reasoning: { effort: 'low' } }, field: 'reasoning', echoed: { effort: 'low', summary: null } },
  { name: 'reasoning with summary only', request: { reasoning: { summary: 'auto' } }, field: 'reasoning', echoed: { effort: null, summary: 'auto' } },
  { name: 'reasoning with neither field', request: { reasoning: {} }, field: 'reasoning', echoed: { effort: null, summary: null } },
  { name: 'text with verbosity only', request: { text: { verbosity: 'low' } }, field: 'text', echoed: { format: { type: 'text' }, verbosity: 'low' } },
  { name: 'text with a null format', request: { text: { format: null } }, field: 'text', echoed: { format: { type: 'text' } } },
  {
    name: 'a function tool with only its name',
    request: { tools: [{ type: 'function', name: 'bare' }] },
    field: 'tools',
    echoed: [{ type: 'function', name: 'bare', description: null, parameters: null, strict: false }],
  },
];

const schema = { type: 'object', properties: { a: { type: 'string' } } };

cases.push(
  {
    name: 'a json_schema format with name and schema only',
    request: { text: { format: { type: 'json_schema', name: 'plain', schema } } },
    field: 'text',
    echoed: { format: { type: 'json_schema', name: 'plain', description: null, schema: null, strict: false } },
  },
  {
    name: 'a json_schema format with description and strict',
    request: { text: { format: { type: 'json_schema', name: 'full', description: 'd', schema, strict: true } } },
    field: 'text',
    echoed: { format: { type: 'json_schema', name: 'full', description: 'd', schema: null, strict: true } },
  },
);

const upstreams: Array<{ name: string; start: () => Promise<UpstreamGateway> }> = [
  { name: 'anthropic', start: () => startAnthropicGateway({ script: [anthropicTextReply(['ok'])] }) },
  { name: 'open responses', start: () => startOpenResponsesGateway({ script: [openResponsesTextReply(['ok'])] }) },
];

describe.each(upstreams)('response echo of request fields through the $name adapter', ({ start }) => {
  it.for(cases)('streams $name in the response shape the spec requires', async ({ request, field, echoed }) => {
    const gateway = await start();
    const frames = await streamResponse(gateway, request);
    expect(terminalOf(frames).response[field]).toEqual(echoed);
  });

  it.for(cases)('returns $name in the response shape the spec requires without streaming', async ({ request, field, echoed }) => {
    const gateway = await start();
    const { status, body } = await readJson(await postJson(gateway.client, '/v1/responses', { model: 'scripted/upstream-model', input: userInput('hello'), ...request }));
    expect(status).toBe(200);
    expect(validator.validate('ResponseResource', body).errors).toEqual([]);
    expect(body[field]).toEqual(echoed);
  });
});
