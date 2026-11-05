import Ajv2020 from 'ajv/dist/2020.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearUntrustedSchemaCaches } from '@momonga/foundation';
import { createBuiltinTools, validateToolInput } from '@momonga/tools';
import { makeTool } from './harness.ts';

const boundaryCalls = vi.hoisted(() => ({ identities: [] as string[] }));

vi.mock('../../foundation/src/validate-untrusted.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../foundation/src/validate-untrusted.ts')>();
  return {
    ...original,
    validateUntrusted: (identity: string, schema: Record<string, unknown>, data: unknown) => {
      boundaryCalls.identities.push(identity);
      return original.validateUntrusted(identity, schema, data);
    },
  };
});

const EMAIL_SCHEMA = { type: 'object', properties: { address: { type: 'string', format: 'email' } }, required: ['address'], additionalProperties: false };
const IF_THEN_EMPTY_SCHEMA = { type: 'object', if: { unevaluatedProperties: {} }, then: {}, unevaluatedProperties: false };

beforeEach(() => {
  boundaryCalls.identities.length = 0;
  clearUntrustedSchemaCaches();
});

describe('built-in tool input validation', () => {
  it('goes through the untrusted-schema boundary', () => {
    const tool = makeTool('builtin_boundary');
    expect(validateToolInput(tool, { value: 'x' })).toEqual({ ok: true, value: { value: 'x' } });
    expect(boundaryCalls.identities).toEqual(['builtin_boundary']);
  });

  it('treats format as an annotation and accepts a string that is not an email', () => {
    const tool = makeTool('builtin_email', { inputSchema: EMAIL_SCHEMA });
    expect(validateToolInput(tool, { address: 'not-an-email' })).toEqual({ ok: true, value: { address: 'not-an-email' } });
  });

  it('accepts an object whose if subschema evaluates every property when then is empty', () => {
    const tool = makeTool('builtin_if_then', { inputSchema: IF_THEN_EMPTY_SCHEMA });
    expect(validateToolInput(tool, { a: null })).toEqual({ ok: true, value: { a: null } });
  });

  it('still rejects input that violates the schema', () => {
    const tool = makeTool('builtin_reject');
    expect(validateToolInput(tool, { value: 1 })).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('lint of the built-in tool schemas', () => {
  it('compiles every built-in input and output schema with Ajv strict mode', () => {
    const tools = createBuiltinTools();
    expect(tools.length).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const tool of tools) {
      for (const [kind, schema] of [['input', tool.inputSchema], ['output', tool.outputSchema]] as const) {
        if (schema === undefined) continue;
        const ajv = new Ajv2020.default({ strict: true, allErrors: true });
        try {
          ajv.compile(schema);
        } catch (error) {
          problems.push(`${tool.name} ${kind}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
