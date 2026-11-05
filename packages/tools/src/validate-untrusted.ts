import type { ErrorObject } from 'ajv/dist/2020.js';
import { SchemaValidatorFailure, cleanFailureMessage, compileUntrustedSchema, recordValidateFailure, untrustedSchemaFailure } from './untrusted-schema.ts';

export type UntrustedVerdict = { valid: true } | { valid: false; errors: readonly ErrorObject[] };

export const validateUntrusted = (identity: string, schema: Record<string, unknown>, data: unknown): UntrustedVerdict => {
  const recorded = untrustedSchemaFailure(identity, schema);
  if (recorded !== undefined) throw new SchemaValidatorFailure(recorded);
  const validate = compileUntrustedSchema(schema);
  try {
    if (validate(data)) return { valid: true };
    return { valid: false, errors: validate.errors ?? [] };
  } catch (error) {
    const failure = new SchemaValidatorFailure(cleanFailureMessage(error instanceof Error ? error.message : String(error)));
    recordValidateFailure(identity, schema, failure.message);
    throw failure;
  }
};
