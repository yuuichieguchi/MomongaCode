import { describe, expect, it } from 'vitest';
import { defineProductSchema } from '@momonga/foundation';
import { BUILTIN_DIALECTS, BUILTIN_DIALECT_IDS, DIALECT_DEFINITION_SCHEMA, strictPerToolOf } from '@momonga/protocol';
import type { DialectDefinition } from '@momonga/protocol';

const validate = defineProductSchema<DialectDefinition>('protocol/dialect-definition.test', DIALECT_DEFINITION_SCHEMA);

describe('a dialect declares whether its wire takes a per-tool strict flag', () => {
  it('every built-in dialect states the field, and only the strict closed form takes it', () => {
    expect(BUILTIN_DIALECT_IDS.map((id) => [id, BUILTIN_DIALECTS[id].strictPerTool])).toEqual([
      ['json-schema-2020-12', false],
      ['inlined-subset', false],
      ['strict-closed', true],
      ['explicit-keys', false],
    ]);
  });

  it('a user dialect may state it, and one without it reads false', () => {
    expect(validate({ rules: [], strictPerTool: true }).valid).toBe(true);
    expect(strictPerToolOf({ rules: [] })).toBe(false);
    expect(strictPerToolOf({ rules: [], strictPerTool: true })).toBe(true);
  });
});
