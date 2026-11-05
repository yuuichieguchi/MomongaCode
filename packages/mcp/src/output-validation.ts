import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/client';
import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import { compileUntrustedSchema, validateUntrusted } from '@momonga/tools';
import { sanitizeSchema } from './schema-sanitizer.ts';

export const validateStructuredOutput = (name: string, tool: Tool | undefined, result: CallToolResult): CallToolResult => {
  const schema = tool?.outputSchema;
  if (schema === undefined) return result;
  const sanitized = sanitizeSchema(schema as Record<string, unknown>);
  compileUntrustedSchema(sanitized);
  if (result.isError === true) return result;
  if (result.structuredContent === undefined) {
    throw new ProtocolError(ProtocolErrorCode.InvalidRequest, `Tool ${name} has an output schema but did not return structured content`);
  }
  const verdict = validateUntrusted(sanitized, result.structuredContent);
  if (!verdict.valid) {
    const detail = verdict.errors.map((error) => `${error.instancePath || '(root)'} ${error.message ?? error.keyword}`).join('; ');
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Structured content does not match the tool's output schema: ${detail}`);
  }
  return result;
};
