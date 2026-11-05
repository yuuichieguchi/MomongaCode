import { describe, expect, it } from 'vitest';
import { SchemaValidatorFailure, untrustedSchemaFailure } from '@momonga/foundation';
import { validateGuarded } from '../src/validate-untrusted.ts';

describe('an engine fault while validating', () => {
  it('is recorded against the schema identity and rethrown as a validator failure', () => {
    const schema = { type: 'object' };
    const faulty = (): never => {
      throw new Error('engine exploded');
    };
    expect(() => validateGuarded('product-schema\u0000x', schema, faulty, {})).toThrow(SchemaValidatorFailure);
    expect(untrustedSchemaFailure('product-schema\u0000x', schema)).toBe('engine exploded');
  });

  it('passes a verdict through untouched', () => {
    expect(validateGuarded('id', {}, () => ({ valid: true }), 1)).toEqual({ valid: true });
  });
});
