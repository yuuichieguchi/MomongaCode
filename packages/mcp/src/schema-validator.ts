import type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator } from '@modelcontextprotocol/client';
import { SchemaValidatorFailure, compileUntrustedSchema, validateUntrusted } from '@momonga/tools';
import { sanitizeSchema } from './schema-sanitizer.ts';

export const createSafeSchemaValidator = (server: string): jsonSchemaValidator => ({
  getValidator: <T>(schema: JsonSchemaType): JsonSchemaValidator<T> => {
    const sanitized = sanitizeSchema(schema as Record<string, unknown>);
    compileUntrustedSchema(sanitized);
    return (input) => {
      try {
        const verdict = validateUntrusted(`mcp-sdk\u0000${server}`, sanitized, input);
        return verdict.valid
          ? { valid: true, data: input as T, errorMessage: undefined }
          : { valid: false, data: undefined, errorMessage: verdict.errors.map((error) => `${error.instancePath || '(root)'} ${error.message ?? error.keyword}`).join('; ') };
      } catch (error) {
        if (error instanceof SchemaValidatorFailure) return { valid: false, data: undefined, errorMessage: `the schema validator failed: ${error.message}` };
        throw error;
      }
    };
  },
});
