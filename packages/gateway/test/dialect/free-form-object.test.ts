import { describe, expect, it } from 'vitest';
import { BUILTIN_DIALECTS, BUILTIN_DIALECT_IDS } from '@momonga/protocol';
import type { AdapterRequest } from '@momonga/protocol';
import { buildResponsesBody } from '../../src/adapters/open-responses/request.ts';
import { renderSchema } from '../../src/dialect/render.ts';
import { definitionOf } from '../../src/dialect/resolve.ts';
import { builtin, failureOf, toolSite } from '../dialect-support.ts';
import { CC_CAPABILITIES, collect, lastCompletionBody, makeAdapter, startFake, terminalOf } from '../cc-support.ts';
import { EVERY_REASONING_IS_OWN } from '../own-reasoning.ts';

const FREE_FORM = { type: 'object', properties: { options: { type: 'object' } }, required: ['options'] };
const CLOSED = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };

const strictClosedExtension = (strictPerTool: boolean | undefined) => ({
  id: 'mine',
  definition: definitionOf('mine', { mine: { extends: 'strict-closed', rules: [], ...(strictPerTool === undefined ? {} : { strictPerTool }) } }),
});

const request: AdapterRequest = {
  model: 'm',
  input: [{ type: 'message', role: 'user', content: 'hello' }],
  tools: [
    { type: 'function', name: 'configure', parameters: FREE_FORM },
    { type: 'function', name: 'read', parameters: CLOSED },
  ],
};

describe('a schema that cannot be expressed strictly', () => {
  it('on a dialect with per-tool strictness is sent unchanged and non-strict', () => {
    const rendered = renderSchema(FREE_FORM, toolSite('configure'), builtin('strict-closed'));
    expect(rendered.strict).toBe(false);
    expect(rendered.schema).toEqual(FREE_FORM);
    expect(renderSchema(CLOSED, toolSite('read'), builtin('strict-closed')).strict).toBe(true);
  });

  it('a free-form root object takes the same route', () => {
    const rendered = renderSchema({ type: 'object', additionalProperties: true }, toolSite('any'), builtin('strict-closed'));
    expect(rendered).toMatchObject({ strict: false, schema: { type: 'object', additionalProperties: true } });
  });

  it('a node that admits no object is no free-form object: closing it is vacuous and the render stays strict', () => {
    const closeEverything = {
      id: 'mine',
      definition: definitionOf('mine', { mine: { rules: [{ select: [{ kinds: ['any'] }], op: 'ensure-key', key: 'additionalProperties', value: false, overwrite: 'always' }], strictPerTool: false } }),
    };
    for (const node of [{ const: 2 }, { type: 'boolean' }, { enum: ['a', 1] }, { type: ['string', 'null'] }]) {
      const schema = { type: 'object', properties: { value: node }, required: ['value'] };
      expect(renderSchema(schema, toolSite('configure'), closeEverything)).toMatchObject({ strict: true, schema: { properties: { value: { ...node, additionalProperties: false } } } });
    }
    expect(failureOf(() => renderSchema({ type: 'object', properties: { value: { items: {} } } }, toolSite('configure'), closeEverything))).toMatchObject({ reason: 'free-form-object' });
  });

  it('a user dialect inherits per-tool strictness from the dialect it extends and can declare it off', () => {
    expect(renderSchema(FREE_FORM, toolSite('configure'), strictClosedExtension(undefined)).strict).toBe(false);
    expect(failureOf(() => renderSchema(FREE_FORM, toolSite('configure'), strictClosedExtension(false)))).toMatchObject({
      reason: 'free-form-object',
      tool: 'configure',
      path: '/properties/options',
      code: 'unsupported_tool_schema',
    });
  });

  it('no built-in dialect closes a free-form object without recording the narrowing', () => {
    for (const id of BUILTIN_DIALECT_IDS) {
      let rendered;
      try {
        rendered = renderSchema(FREE_FORM, toolSite('configure'), builtin(id));
      } catch {
        expect(BUILTIN_DIALECTS[id].strictPerTool).toBe(false);
        continue;
      }
      const options = (rendered.schema as { properties: { options: Record<string, unknown> } }).properties.options;
      if (options['additionalProperties'] === false) expect(rendered.narrowings).toContainEqual({ tool: 'configure', path: '/properties/options' });
    }
  });

  it('the json-schema-2020-12 dialect leaves a free-form object untouched', () => {
    const rendered = renderSchema(FREE_FORM, toolSite('configure'), builtin('json-schema-2020-12'));
    expect(rendered.schema).toEqual(FREE_FORM);
    expect(rendered.narrowings).toEqual([]);
  });

  it('the open-responses body carries the per-tool strict flag', () => {
    const body = buildResponsesBody(request, EVERY_REASONING_IS_OWN, { schemaDialect: 'strict-closed' });
    const tools = body.tools as { name: string; strict?: boolean; parameters?: unknown }[];
    expect(tools.map((tool) => [tool.name, tool.strict])).toEqual([
      ['configure', false],
      ['read', true],
    ]);
    expect(tools[0]?.parameters).toEqual(FREE_FORM);
  });

  it('the chat-completions body carries the per-tool strict flag, and an argument the original schema refuses is malformed output', async () => {
    const fake = await startFake({
      scenario: 'tools-ok',
      script: [
        {
          kind: 'stream',
          chunks: [
            { delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'configure', arguments: '{"options":"loud"}' } }] } },
            { delta: {}, finishReason: 'tool_calls' },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      ],
    });
    const adapter = makeAdapter(fake, { schemaDialect: () => 'strict-closed', capabilities: async () => ({ ...CC_CAPABILITIES, schemaDialect: 'strict-closed' }) });
    const { events, error } = await collect(adapter, request);
    const tools = lastCompletionBody(fake).tools as { function: { name: string; strict?: boolean } }[];
    expect(tools.map((tool) => [tool.function.name, tool.function.strict])).toEqual([
      ['configure', false],
      ['read', true],
    ]);
    const code = error === undefined ? terminalOf(events).response.error?.code : (error as { code?: string }).code;
    expect(code).toBe('malformed_output');
  });
});
