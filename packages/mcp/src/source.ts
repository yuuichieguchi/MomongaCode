import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import { defineTool, ToolExecutionError } from '@momonga/tools';
import type { AnyTool, ToolResult, ToolSource, ToolSourceListing } from '@momonga/tools';
import { McpUnavailableError } from './connection.ts';
import type { McpServerConnection } from './connection.ts';
import { sanitizeSchema } from './schema-sanitizer.ts';
import { capText, sanitizeServerText } from './text.ts';

const MAX_TOOL_NAME_CHARS = 64;
const MAX_DESCRIPTION_CHARS = 2048;
const MAX_TITLE_CHARS = 200;
const HASH_CHARS = 8;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const NO_OUTPUT = '(no output)';
const LINE_BREAKS = /[\n\t]/g;
const DISALLOWED_NAME_CHARACTERS = /[^A-Za-z0-9_-]/g;

export type McpToolSourceOptions = {
  server: string;
  connection: McpServerConnection;
  requestTimeoutMs?: number;
};

const normalizeToolPart = (server: string, original: string): string => {
  const prefixLength = `mcp__${server}__`.length;
  const normalized = original.replace(DISALLOWED_NAME_CHARACTERS, '_');
  if (normalized === original && prefixLength + normalized.length <= MAX_TOOL_NAME_CHARS) return normalized;
  const hash = sha256Hex(original).slice(0, HASH_CHARS);
  return `${normalized.slice(0, MAX_TOOL_NAME_CHARS - prefixLength - HASH_CHARS - 1)}_${hash}`;
};

export const assertServerNameFits = (server: string): void => {
  const prefixLength = `mcp__${server}__`.length;
  if (prefixLength + 1 + 1 + HASH_CHARS > MAX_TOOL_NAME_CHARS) {
    throw new Error(`MCP server name "${server}" is too long: mcp__<server>__<tool> names are limited to ${MAX_TOOL_NAME_CHARS} characters`);
  }
};

const describe = (tool: Tool): string => capText(sanitizeServerText(tool.description ?? tool.title ?? tool.name), MAX_DESCRIPTION_CHARS);

const titleOf = (tool: Tool): string =>
  capText(sanitizeServerText(tool.title ?? tool.name).replace(LINE_BREAKS, ' '), MAX_TITLE_CHARS);

const mapContentBlock = (block: CallToolResult['content'][number]): string => {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'image':
      return `[image ${block.mimeType}, ${Buffer.byteLength(block.data, 'base64')} bytes]`;
    case 'audio':
      return `[audio ${block.mimeType}, ${Buffer.byteLength(block.data, 'base64')} bytes]`;
    case 'resource_link':
      return `[resource ${block.uri}]`;
    case 'resource':
      return 'text' in block.resource
        ? block.resource.text
        : `[resource ${block.resource.uri}, ${Buffer.byteLength(block.resource.blob, 'base64')} bytes]`;
  }
};

const mapResult = (result: CallToolResult): ToolResult => {
  const hasText = result.content.some((block) => block.type === 'text');
  const rendered = result.content.map(mapContentBlock);
  if (result.structuredContent !== undefined && !hasText) rendered.push(canonicalJson(result.structuredContent));
  let output = rendered.join('\n');
  if (output === '') output = NO_OUTPUT;
  return {
    status: result.isError === true ? 'failed' : 'completed',
    output,
    content: [{ type: 'content', content: { type: 'text', text: output } }],
  };
};

const toExecutionError = (server: string, error: unknown): ToolExecutionError => {
  if (error instanceof McpUnavailableError) return new ToolExecutionError(error.message);
  return new ToolExecutionError(`MCP server "${server}" failed: ${error instanceof Error ? error.message : String(error)}`);
};

const buildTool = (
  options: McpToolSourceOptions,
  tool: Tool,
  toolPart: string,
  inputSchema: Record<string, unknown>,
): AnyTool => {
  const { server, connection } = options;
  const annotations = tool.annotations;
  const readOnly = annotations?.readOnlyHint === true;
  return defineTool<Record<string, unknown>>({
    name: `mcp__${server}__${toolPart}`,
    description: describe(tool),
    kind: readOnly ? 'read' : 'other',
    sideEffect: readOnly && annotations?.destructiveHint !== true ? 'read_only' : 'write',
    inputSchema,
    schemaMode: 'lenient',
    timeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    title: () => `${sanitizeServerText(server)}: ${titleOf(tool)}`,
    subject: () => ({ kind: 'mcp', server, tool: toolPart }),
    execute: async (input, ctx) => {
      let result: CallToolResult;
      try {
        result = await connection.callTool({
          name: tool.name,
          arguments: input,
          signal: ctx.signal,
          timeoutMs: Math.max(1, ctx.deadlineAt - ctx.clock.now()),
          ...(ctx.traceparent === undefined ? {} : { traceparent: ctx.traceparent }),
          ...(ctx.tracestate === undefined ? {} : { tracestate: ctx.tracestate }),
        });
      } catch (error) {
        throw toExecutionError(server, error);
      }
      return mapResult(result);
    },
  });
};

export const createMcpToolSource = (options: McpToolSourceOptions): ToolSource => {
  const { server, connection } = options;
  const listWithNotices = async (): Promise<ToolSourceListing> => {
    assertServerNameFits(server);
    const listed = await connection.listTools();
    const tools: AnyTool[] = [];
    const notices: string[] = [];
    for (const tool of listed) {
      let displayName = tool.name;
      try {
        const toolPart = normalizeToolPart(server, tool.name);
        displayName = `mcp__${server}__${toolPart}`;
        tools.push(buildTool(options, tool, toolPart, sanitizeSchema(tool.inputSchema)));
      } catch (error) {
        notices.push(`skipped ${JSON.stringify(displayName)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { tools, notices };
  };
  return {
    id: `mcp__${server}`,
    list: async () => (await listWithNotices()).tools,
    listWithNotices,
  };
};
