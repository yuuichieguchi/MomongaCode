import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import { SchemaValidatorFailure, canonicalJson, sha256Hex } from '@momonga/foundation';
import { defineTool, ToolExecutionError, ToolInputRequired, TransientToolError } from '@momonga/tools';
import type { AnyTool, ToolListOptions, ToolResult, ToolResume, ToolSource, ToolSourceListing, ToolStop } from '@momonga/tools';
import { McpUnavailableError } from './connection.ts';
import { parseElicitationAnswer } from './input-requests.ts';
import { authorizationRequiredFor, isTransientRemoteFailure } from './remote-errors.ts';
import { mcpToolIdentity } from './tool-identity.ts';
import { McpInputSuspension, parseCheckpoint } from './suspension.ts';
import { MCP_IDLE_SETTING_KEYS, MCP_TOOL_IDLE_TIMEOUT_MS, MCP_TOOL_TOTAL_TIMEOUT_MS, durationText } from './call-bounds.ts';
import type { McpTransportKind } from './call-bounds.ts';
import { pollCeilingMs } from './tasks.ts';
import type { McpResume } from './suspension.ts';
import type { McpServerConnection } from './connection.ts';
import { boundedSchemaCopy } from './schema-copy.ts';
import { capText, sanitizeServerText } from './text.ts';

const MAX_TOOL_NAME_CHARS = 64;
const MAX_DESCRIPTION_CHARS = 2048;
const MAX_TITLE_CHARS = 200;
const HASH_CHARS = 8;
const NO_OUTPUT = '(no output)';
const LINE_BREAKS = /[\n\t]/g;
const DISALLOWED_NAME_CHARACTERS = /[^A-Za-z0-9_-]/g;

export type McpToolSourceOptions = {
  server: string;
  connection: McpServerConnection;
  toolIdleTimeoutMs?: number;
  toolTotalTimeoutMs?: number;
  takeNotices?: () => string[];
};

type CallBounds = { idleMs: number | undefined; totalMs: number };

const boundsOf = (options: McpToolSourceOptions): CallBounds => {
  const idle = options.toolIdleTimeoutMs ?? MCP_TOOL_IDLE_TIMEOUT_MS[options.connection.transportKind];
  return { idleMs: idle === 0 ? undefined : idle, totalMs: options.toolTotalTimeoutMs ?? MCP_TOOL_TOTAL_TIMEOUT_MS };
};

const UNKNOWN_RUN = 'The server may have run it; check before repeating it.';

const STOP_SENTENCES: Record<ToolStop['bound'], (server: string, tool: string, duration: string, transport: McpTransportKind) => string> = {
  idle: (server, tool, duration, transport) => `MCP server "${server}" sent no response or progress for ${duration}, so the call to ${tool} was stopped. ${UNKNOWN_RUN} To wait longer, raise ${MCP_IDLE_SETTING_KEYS[transport]}.`,
  total: (server, tool, duration) => `The call to ${tool} on MCP server "${server}" reached the overall limit of ${duration} and was stopped. ${UNKNOWN_RUN}`,
  deadline: (server, tool, duration) => `The call to ${tool} on MCP server "${server}" reached the run deadline after ${duration} and was stopped. ${UNKNOWN_RUN}`,
};

const stopSentence = (server: string, tool: string, stop: ToolStop, transport: McpTransportKind): string => STOP_SENTENCES[stop.bound](server, tool, durationText(stop.ms), transport);

const cancelSentence = (cancelled: boolean): string =>
  cancelled ? 'The task was cancelled on the server.' : 'The task could not be cancelled and may still be running on the server.';

const taskIdOf = (checkpoint: Record<string, unknown> | undefined): string | undefined => {
  if (checkpoint === undefined) return undefined;
  const parsed = parseCheckpoint(checkpoint);
  return parsed.kind === 'task' ? parsed.taskId : undefined;
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

const mapResult = (result: CallToolResult, redact: (text: string) => string): ToolResult => {
  const hasText = result.content.some((block) => block.type === 'text');
  const rendered = result.content.map(mapContentBlock);
  if (result.structuredContent !== undefined && !hasText) rendered.push(canonicalJson(result.structuredContent));
  let output = redact(rendered.join('\n'));
  if (output === '') output = NO_OUTPUT;
  return {
    status: result.isError === true ? 'failed' : 'completed',
    output,
    content: [{ type: 'content', content: { type: 'text', text: output } }],
  };
};

const resumeOf = (resume: ToolResume | undefined): McpResume | undefined => {
  if (resume?.checkpoint === undefined) return undefined;
  const answers = Object.fromEntries(Object.entries(resume.inputResponses ?? {}).map(([key, value]) => [key, parseElicitationAnswer(key, value)]));
  return { checkpoint: parseCheckpoint(resume.checkpoint), answers };
};

const toExecutionError = (server: string, error: unknown, redact: (text: string) => string): ToolExecutionError | TransientToolError => {
  if (error instanceof McpUnavailableError) return new ToolExecutionError(redact(error.message));
  const message = redact(`MCP server "${server}" failed: ${error instanceof Error ? error.message : String(error)}`);
  return isTransientRemoteFailure(error) ? new TransientToolError(message) : new ToolExecutionError(message);
};

const buildTool = (
  options: McpToolSourceOptions,
  tool: Tool,
  toolPart: string,
  inputSchema: Record<string, unknown>,
): AnyTool => {
  const { server, connection } = options;
  const bounds = boundsOf(options);
  return defineTool<Record<string, unknown>>({
    name: `mcp__${server}__${toolPart}`,
    description: describe(tool),
    kind: 'other',
    sideEffect: 'write',
    subjectKind: 'mcp',
    inputSchema,
    ...(tool.outputSchema === undefined ? {} : { outputSchema: boundedSchemaCopy(tool.outputSchema) }),
    server,
    validatorIdentity: mcpToolIdentity(server, tool.name),
    timeoutMs: bounds.totalMs,
    ...(bounds.idleMs === undefined ? {} : { idleTimeoutMs: bounds.idleMs }),
    stopText: async (stop) => {
      const sentence = connection.redact(stopSentence(server, tool.name, stop, connection.transportKind));
      const taskId = taskIdOf(stop.checkpoint);
      const cancelled = taskId === undefined ? undefined : connection.cancelOutcome(taskId);
      return cancelled === undefined ? sentence : `${sentence} ${cancelSentence(await cancelled)}`;
    },
    title: () => `${sanitizeServerText(server)}: ${titleOf(tool)}`,
    subject: () => ({ kind: 'mcp', server, tool: toolPart }),
    execute: async (input, ctx) => {
      const resume = resumeOf(ctx.resume);
      if (resume?.checkpoint.kind === 'mrtr' || resume?.checkpoint.kind === 'parked') ctx.checkpoint(undefined);
      let result: CallToolResult;
      try {
        result = await connection.callTool({
          name: tool.name,
          arguments: input,
          signal: ctx.signal,
          onProgress: () => ctx.reportProgress(),
          pollCeilingMs: pollCeilingMs(bounds.idleMs, bounds.totalMs),
          ...(ctx.traceparent === undefined ? {} : { traceparent: ctx.traceparent }),
          ...(ctx.tracestate === undefined ? {} : { tracestate: ctx.tracestate }),
          ...(resume === undefined ? {} : { resume }),
          onCheckpoint: (checkpoint) => ctx.checkpoint({ ...checkpoint }),
        });
      } catch (error) {
        if (error instanceof McpInputSuspension) {
          throw new ToolInputRequired({ server, requests: error.requests, checkpoint: { ...error.checkpoint } });
        }
        if (error instanceof SchemaValidatorFailure) {
          return { status: 'failed', output: `Tool mcp__${server}__${toolPart}: its output could not be checked because its output schema validator failed, so the output is withheld. The tool is unavailable for the rest of this run.`, validatorFailure: error.message };
        }
        const unauthorized = authorizationRequiredFor(error);
        if (unauthorized !== undefined) {
          return {
            status: 'failed',
            output: connection.redact(`MCP server "${server}" requires authorization before it can be used`),
            authorizationRequired: { server },
          };
        }
        throw toExecutionError(server, error, (text) => connection.redact(text));
      }
      return mapResult(result, (text) => connection.redact(text));
    },
    releaseCheckpoint: (checkpoint, ctx) => connection.releaseCheckpoint(parseCheckpoint(checkpoint), { signal: ctx.signal }),
  });
};

export const createMcpToolSource = (options: McpToolSourceOptions): ToolSource => {
  const { server, connection } = options;
  const listWithNotices = async (listOptions?: ToolListOptions): Promise<ToolSourceListing> => {
    assertServerNameFits(server);
    let listed: Tool[];
    try {
      listed = await connection.listTools(listOptions?.signal === undefined ? undefined : { signal: listOptions.signal });
    } catch (error) {
      if (authorizationRequiredFor(error) === undefined) throw error;
      return { tools: [], notices: options.takeNotices?.() ?? [], authorizationRequired: [server] };
    }
    const tools: AnyTool[] = [];
    const notices: string[] = [];
    for (const tool of listed) {
      let displayName = tool.name;
      try {
        const toolPart = normalizeToolPart(server, tool.name);
        displayName = `mcp__${server}__${toolPart}`;
        tools.push(buildTool(options, tool, toolPart, boundedSchemaCopy(tool.inputSchema)));
      } catch (error) {
        notices.push(`skipped ${JSON.stringify(displayName)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { tools, notices: [...notices, ...(options.takeNotices?.() ?? [])] };
  };
  return {
    id: `mcp__${server}`,
    list: async (listOptions) => (await listWithNotices(listOptions)).tools,
    listWithNotices,
  };
};
