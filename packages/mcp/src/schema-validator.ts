import type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator } from '@modelcontextprotocol/client';

export const createSafeSchemaValidator = (): jsonSchemaValidator => ({
  getValidator: <T>(_schema: JsonSchemaType): JsonSchemaValidator<T> => (input) => ({ valid: true, data: input as T, errorMessage: undefined }),
});
