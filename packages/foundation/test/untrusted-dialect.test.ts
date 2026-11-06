import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { SchemaValidatorFailure, validateUntrusted } from '@momonga/foundation';

const require = createRequire(import.meta.url);
const ata = require(path.join(path.dirname(require.resolve('@momonga/ata-validator/package.json')), 'lib', 'dialect.js')) as {
  draftCode(uri: string): number;
  DRAFT6_SCHEMAS: ReadonlySet<string>;
  V1_DIALECTS: ReadonlySet<string>;
};

const EXPLICIT_2020_12 = new Set(['https://json-schema.org/draft/2020-12/schema', 'https://json-schema.org/draft/2020-12/schema#']);

const URIS = [
  'http://json-schema.org/draft-07/schema#',
  'http://json-schema.org/draft-07/schema',
  'https://json-schema.org/draft-07/schema#',
  'https://json-schema.org/draft-07/schema',
  'http://json-schema.org/draft-06/schema#',
  'http://json-schema.org/draft-06/schema',
  'http://json-schema.org/draft-04/schema#',
  'https://json-schema.org/draft/2019-09/schema',
  'https://json-schema.org/draft/2020-12/schema',
  'https://json-schema.org/draft/2020-12/schema#',
  'http://json-schema.org/draft/2020-12/schema',
  'https://json-schema.org/v1',
  'https://example.invalid/dialect',
];

const accepted = (uri: string): boolean => {
  try {
    validateUntrusted('dialect', { $schema: uri, type: 'object' }, {});
    return true;
  } catch (error) {
    if (error instanceof SchemaValidatorFailure) return false;
    throw error;
  }
};

const ataTreatsAsDraft07 = (uri: string): boolean => ata.draftCode(uri) === 1 && !ata.DRAFT6_SCHEMAS.has(uri);

describe('the one dialect rule at the untrusted-schema boundary', () => {
  it.each(['https://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft-07/schema'])('refuses %s, which ata evaluates as 2020-12', (uri) => {
    expect(accepted(uri)).toBe(false);
  });

  it.each(URIS)('accepts %s exactly when ata detects draft-07 or the URI names 2020-12', (uri) => {
    expect(accepted(uri)).toBe(ataTreatsAsDraft07(uri) || EXPLICIT_2020_12.has(uri));
  });

  it('evaluates an accepted draft-07 schema with draft-07 semantics', () => {
    const schema = { $schema: 'http://json-schema.org/draft-07/schema#', items: [{ type: 'string' }], additionalItems: false };
    expect(validateUntrusted('dialect', schema, ['a', 1]).valid).toBe(false);
    expect(validateUntrusted('dialect', schema, ['a']).valid).toBe(true);
  });
});
