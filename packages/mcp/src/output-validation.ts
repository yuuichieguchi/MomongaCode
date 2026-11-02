import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/client';
import type { CallToolResult, JsonSchemaType, Tool } from '@modelcontextprotocol/client';
import { createSafeSchemaValidator } from './schema-validator.ts';

const validator = createSafeSchemaValidator();

export const validateStructuredOutput = (name: string, tool: Tool | undefined, result: CallToolResult): CallToolResult => {
  const schema = tool?.outputSchema;
  if (schema === undefined) return result;
  let validate;
  try {
    validate = validator.getValidator<unknown>(schema as JsonSchemaType);
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool '${name}' has an invalid outputSchema: ${reason}`);
  }
  if (result.isError === true) return result;
  if (result.structuredContent === undefined) {
    throw new ProtocolError(ProtocolErrorCode.InvalidRequest, `Tool ${name} has an output schema but did not return structured content`);
  }
  const verdict = validate(result.structuredContent);
  if (!verdict.valid) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Structured content does not match the tool's output schema: ${verdict.errorMessage}`);
  }
  return result;
};
