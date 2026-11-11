import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/client';
import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import { checkWithPatterns, compileUntrustedSchema, patternRefusal, validateUntrusted } from '@momonga/foundation';
import { boundedSchemaCopy } from './schema-copy.ts';

export const validateStructuredOutput = async (
  identity: string,
  name: string,
  tool: Tool | undefined,
  result: CallToolResult,
  signal: AbortSignal | undefined,
): Promise<CallToolResult> => {
  const schema = tool?.outputSchema;
  if (schema === undefined) return result;
  const copied = boundedSchemaCopy(schema as Record<string, unknown>);
  compileUntrustedSchema(copied);
  if (result.isError === true) return result;
  if (result.structuredContent === undefined) {
    throw new ProtocolError(ProtocolErrorCode.InvalidRequest, `Tool ${name} has an output schema but did not return structured content`);
  }
  const content = result.structuredContent;
  const checked = await checkWithPatterns(() => validateUntrusted(identity, copied, content), signal === undefined ? {} : { signal });
  if (checked.kind === 'stopped') throw (signal as AbortSignal).reason;
  if (checked.kind === 'not-checked') throw new ProtocolError(ProtocolErrorCode.InvalidParams, patternRefusal(`output of ${name}`, content, checked));
  const verdict = checked.value;
  if (!verdict.valid) {
    const detail = verdict.errors.map((error) => `${error.instancePath || '(root)'} ${error.message ?? error.keyword}`).join('; ');
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Structured content does not match the tool's output schema: ${detail}`);
  }
  return result;
};
