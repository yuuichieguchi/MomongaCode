import { describe, expect, it } from 'vitest';
import { defineProductSchema } from '@momonga/foundation';
import { GENERIC_SERVER_KIND, SERVER_KINDS } from '../src/index.ts';

const JSON_CHECK_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'is'],
      properties: { path: { type: 'array', items: { type: 'string' } }, is: { enum: ['string', 'number', 'array', 'object'] } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'eachHas', 'atLeastOne'],
      properties: { path: { type: 'array', items: { type: 'string' } }, eachHas: { type: 'array', items: { type: 'string' }, minItems: 1 }, atLeastOne: { const: true } },
    },
  ],
};

const ADAPTERS = ['ollama', 'chat-completions', 'open-responses', 'anthropic'];

const SERVER_KINDS_SCHEMA = {
  type: 'array',
  minItems: 1,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'label', 'adapterLabel', 'adapter', 'baseUrlSuffix', 'settings'],
    properties: {
      kind: { type: 'string', pattern: '^[a-z][a-z0-9._-]*$' },
      label: { type: 'string', minLength: 1 },
      adapterLabel: { type: 'string', minLength: 1 },
      adapter: { enum: ADAPTERS },
      impliedByAdapter: { enum: ADAPTERS },
      address: { type: 'object', additionalProperties: false, required: ['host', 'port'], properties: { host: { type: 'string' }, port: { type: 'integer', minimum: 1, maximum: 65535 } } },
      baseUrlSuffix: { type: 'string', pattern: '^(/.*)?$' },
      settings: { type: 'object', additionalProperties: false, properties: { billing: { const: 'local' }, maxConcurrency: { type: 'integer', minimum: 1 } } },
      defaultTag: { type: 'string', minLength: 1 },
      recognise: {
        type: 'object',
        additionalProperties: false,
        required: ['requests'],
        properties: {
          requests: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['method', 'path', 'expect'],
              properties: { method: { const: 'GET' }, path: { type: 'string', pattern: '^/' }, expect: { type: 'array', minItems: 1, items: JSON_CHECK_SCHEMA } },
            },
          },
        },
      },
      read: {
        type: 'object',
        additionalProperties: false,
        required: ['list'],
        properties: {
          list: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'array', 'id'],
            properties: {
              path: { type: 'string', pattern: '^/' },
              array: { type: 'string' },
              id: { type: 'string' },
              filter: { type: 'object', additionalProperties: false, required: ['field', 'equals'], properties: { field: { type: 'string' }, equals: { type: 'string' } } },
            },
          },
          window: { type: 'string' },
          ceiling: { type: 'string' },
          lengthIsMaximum: { const: true },
          tools: { const: 'unknown' },
          details: {
            type: 'object',
            additionalProperties: false,
            required: ['method', 'path', 'body', 'tools', 'ceilingTemplate'],
            properties: {
              method: { const: 'POST' },
              path: { type: 'string', pattern: '^/' },
              body: { type: 'object', additionalProperties: false, required: ['model'], properties: { model: { const: '$id' } } },
              tools: { type: 'string' },
              ceilingTemplate: { type: 'string' },
            },
          },
        },
      },
    },
  },
};

const kindNamed = (kind: string) => {
  const found = SERVER_KINDS.find((entry) => entry.kind === kind);
  if (found === undefined) throw new Error(`the registry has no kind ${kind}`);
  return found;
};

describe('the registry of server kinds (design-model-names 2.8, 4.14)', () => {
  it('lists ollama, lmstudio, anthropic and the generic kind, in that order', () => {
    expect(SERVER_KINDS.map((entry) => entry.kind)).toEqual(['ollama', 'lmstudio', 'anthropic', GENERIC_SERVER_KIND]);
  });

  it('gives only ollama a default tag, and it is latest', () => {
    expect(kindNamed('ollama').defaultTag).toBe('latest');
    expect(SERVER_KINDS.filter((entry) => entry.defaultTag !== undefined).map((entry) => entry.kind)).toEqual(['ollama']);
  });

  it('describes LM Studio as an OpenAI-compatible server that is local, serves one request at a time and is written with /v1', () => {
    const lmstudio = kindNamed('lmstudio');
    expect(lmstudio.adapter).toBe('chat-completions');
    expect(lmstudio.settings).toEqual({ billing: 'local', maxConcurrency: 1 });
    expect(lmstudio.baseUrlSuffix).toBe('/v1');
  });

  it('knows ollama and anthropic by their adapter alone, and no other kind', () => {
    expect(kindNamed('ollama').impliedByAdapter).toBe('ollama');
    expect(kindNamed('anthropic').impliedByAdapter).toBe('anthropic');
    expect(SERVER_KINDS.filter((entry) => entry.impliedByAdapter !== undefined).map((entry) => entry.kind)).toEqual(['ollama', 'anthropic']);
  });

  it('validates against its schema', () => {
    const validate = defineProductSchema('protocol-test/server-kinds', SERVER_KINDS_SCHEMA);
    expect(validate(SERVER_KINDS)).toMatchObject({ valid: true });
  });
});
