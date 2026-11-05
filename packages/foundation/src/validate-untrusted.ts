import { SchemaValidatorFailure, cleanFailureMessage, compileUntrustedSchema, createUntrustedSchemaCompiler, recordValidateFailure } from './untrusted-schema.ts';
import type { RemoteDocuments, UntrustedValidate, UntrustedVerdict } from './untrusted-schema.ts';

export type { UntrustedVerdict } from './untrusted-schema.ts';

type Compile = (schema: Record<string, unknown>) => UntrustedValidate;

const validateThrough =
  (compile: Compile) =>
  (identity: string, schema: Record<string, unknown>, data: unknown): UntrustedVerdict => {
    const validate = compile(schema);
    try {
      return validate(data);
    } catch (error) {
      const failure = new SchemaValidatorFailure(cleanFailureMessage(error instanceof Error ? error.message : String(error)));
      recordValidateFailure(identity, schema, failure.message);
      throw failure;
    }
  };

export const validateUntrusted = validateThrough((schema) => compileUntrustedSchema(schema));

export const createUntrustedBoundary = (
  remotes: RemoteDocuments,
): { compile: Compile; validate: (identity: string, schema: Record<string, unknown>, data: unknown) => UntrustedVerdict } => {
  const compile = createUntrustedSchemaCompiler(remotes);
  return { compile, validate: validateThrough(compile) };
};
