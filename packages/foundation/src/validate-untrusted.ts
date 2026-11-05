import { SchemaValidatorFailure, cleanFailureMessage, compileUntrustedSchema, createUntrustedSchemaCompiler, recordValidateFailure } from './untrusted-schema.ts';
import type { Engine } from './untrusted-engine.ts';
import type { RemoteDocuments, UntrustedValidate, UntrustedVerdict } from './untrusted-schema.ts';

export type { UntrustedVerdict } from './untrusted-schema.ts';

type Compile = (schema: Record<string, unknown>) => UntrustedValidate;

export const validateGuarded = (identity: string, schema: Record<string, unknown>, validate: UntrustedValidate, data: unknown): UntrustedVerdict => {
  try {
    return validate(data);
  } catch (error) {
    const failure = new SchemaValidatorFailure(cleanFailureMessage(error instanceof Error ? error.message : String(error)));
    recordValidateFailure(identity, schema, failure.message);
    throw failure;
  }
};

const validateThrough =
  (compile: Compile) =>
  (identity: string, schema: Record<string, unknown>, data: unknown): UntrustedVerdict =>
    validateGuarded(identity, schema, compile(schema), data);

export const validateUntrusted = validateThrough((schema) => compileUntrustedSchema(schema));

export const createUntrustedBoundary = (
  { remotes, engine }: { remotes: RemoteDocuments; engine: Engine },
): { compile: Compile; validate: (identity: string, schema: Record<string, unknown>, data: unknown) => UntrustedVerdict } => {
  const compile = createUntrustedSchemaCompiler({ remotes, engine });
  return { compile, validate: validateThrough(compile) };
};
