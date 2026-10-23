import type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator } from '@modelcontextprotocol/client';
import { compileUntrustedSchema } from '@momonga/tools';
import { sanitizeSchema } from './schema-sanitizer.ts';

export const createSafeSchemaValidator = (): jsonSchemaValidator => ({
  getValidator: <T>(schema: JsonSchemaType): JsonSchemaValidator<T> => {
    const validate = compileUntrustedSchema(sanitizeSchema(schema as Record<string, unknown>));
    return (input) =>
      validate(input)
        ? { valid: true, data: input as T, errorMessage: undefined }
        : { valid: false, data: undefined, errorMessage: (validate.errors ?? []).map((error) => `${error.instancePath || '(root)'} ${error.message ?? error.keyword}`).join('; ') };
  },
});
