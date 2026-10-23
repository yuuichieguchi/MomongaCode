import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { type CallToolResult, Server, type Tool } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import {
  MODERN_FIXTURE_GRANDCHILD_ENV,
  MODERN_FIXTURE_IMAGE_BYTES,
  MODERN_FIXTURE_LONG_TOOL_NAME,
  MODERN_FIXTURE_PAGE_SIZE,
  MODERN_FIXTURE_RECORD_ENV,
  type ModernFixtureRecord,
} from './mcp-fixtures.ts';

const objectSchema = (properties: NonNullable<Tool['inputSchema']['properties']>, required: string[]): Tool['inputSchema'] => ({
  type: 'object',
  properties,
  required,
});

const BASE_TOOLS: Tool[] = [
  { name: 'echo', description: 'Echo the text back', inputSchema: objectSchema({ text: { type: 'string' } }, ['text']) },
  {
    name: 'add',
    description: 'Add two numbers',
    inputSchema: objectSchema({ a: { type: 'number' }, b: { type: 'number' } }, ['a', 'b']),
  },
  {
    name: 'slow',
    description: 'Wait until cancelled or until ms elapse',
    inputSchema: objectSchema({ ms: { type: 'number' } }, []),
  },
  { name: 'fail', description: 'Always fails with isError', inputSchema: objectSchema({}, []) },
  { name: 'crash', description: 'Exits the server mid-call', inputSchema: objectSchema({ code: { type: 'number' } }, []) },
  { name: 'image', description: 'Returns an image', inputSchema: objectSchema({}, []) },
  {
    name: 'structured',
    description: 'Returns structured content only',
    inputSchema: objectSchema({}, []),
    outputSchema: objectSchema({ answer: { type: 'number' }, label: { type: 'string' } }, ['answer', 'label']),
  },
  { name: 'trigger_list_changed', description: 'Adds a tool and notifies list_changed', inputSchema: objectSchema({}, []) },
  {
    name: 'read_only',
    description: 'A read-only tool',
    inputSchema: objectSchema({}, []),
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'draft07',
    description: 'A tool with a draft-07 schema',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      definitions: { unused: { type: 'string' } },
    },
  },
  { name: 'dotted.name/with-slash', description: 'A tool whose name has punctuation', inputSchema: objectSchema({}, []) },
  { name: MODERN_FIXTURE_LONG_TOOL_NAME, description: 'A tool with a very long name', inputSchema: objectSchema({}, []) },
  {
    name: 'catastrophic_output',
    description: 'Structured output whose schema has a catastrophic pattern',
    inputSchema: objectSchema({}, []),
    outputSchema: objectSchema({ value: { type: 'string', pattern: '^(a+)+$' } }, ['value']),
  },
];

const recordFile = process.env[MODERN_FIXTURE_RECORD_ENV];

const record = (entry: ModernFixtureRecord): void => {
  if (recordFile !== undefined && recordFile !== '') fs.appendFileSync(recordFile, `${JSON.stringify(entry)}\n`);
};

const text = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }] });

const createFixtureServer = (): Server => {
  const tools = [...BASE_TOOLS];
  const server = new Server(
    { name: 'momonga-modern-fixture', version: '1.0.0' },
    {
      capabilities: { tools: { listChanged: true } },
      instructions: 'Modern fixture server',
    },
  );

  server.setRequestHandler('tools/list', (request) => {
    const cursor = request.params?.cursor;
    record({ type: 'list', cursor: cursor ?? null });
    const start = cursor === undefined ? 0 : Number(cursor);
    const page = tools.slice(start, start + MODERN_FIXTURE_PAGE_SIZE);
    const next = start + MODERN_FIXTURE_PAGE_SIZE;
    return next < tools.length ? { tools: page, nextCursor: String(next) } : { tools: page };
  });

  server.setRequestHandler('tools/call', async (request, ctx) => {
    const { name } = request.params;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    record({ type: 'call', tool: name, meta: request.params._meta ?? null, envelope: ctx.mcpReq.envelope ?? null });
    switch (name) {
      case 'echo':
        return text(String(args['text']));
      case 'add':
        return text(String(Number(args['a']) + Number(args['b'])));
      case 'slow': {
        const ms = typeof args['ms'] === 'number' ? args['ms'] : 600000;
        const signal = ctx.mcpReq.signal;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              record({ type: 'cancelled', tool: 'slow', requestId: ctx.mcpReq.id, reason: String(signal.reason ?? '') });
              resolve();
            },
            { once: true },
          );
        });
        return text('slow done');
      }
      case 'fail':
        return { content: [{ type: 'text', text: 'fixture failure' }], isError: true };
      case 'crash':
        process.exit(typeof args['code'] === 'number' ? args['code'] : 3);
      case 'image':
        return { content: [{ type: 'image', data: Buffer.from(MODERN_FIXTURE_IMAGE_BYTES).toString('base64'), mimeType: 'image/png' }] };
      case 'structured':
        return { content: [], structuredContent: { answer: 42, label: 'forty-two' } };
      case 'trigger_list_changed':
        if (!tools.some((tool) => tool.name === 'added_later')) {
          tools.push({ name: 'added_later', description: 'Added by list_changed', inputSchema: objectSchema({}, []) });
        }
        await server.sendToolListChanged();
        return text('list changed');
      case 'read_only':
        return text('read only');
      case 'draft07':
        return text(String(args['value']));
      case 'dotted.name/with-slash':
        return text('dotted');
      case MODERN_FIXTURE_LONG_TOOL_NAME:
        return text('long');
      case 'catastrophic_output':
        return { content: [], structuredContent: { value: `${'a'.repeat(36)}!` } };
      case 'added_later':
        return text('added later');
      default:
        return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true };
    }
  });

  return server;
};

const runServer = (): void => {
  if (process.env[MODERN_FIXTURE_GRANDCHILD_ENV] === '1') {
    const grandchild = spawn('sleep', ['600'], { stdio: 'ignore' });
    record({ type: 'grandchild', pid: grandchild.pid ?? -1 });
  }
  serveStdio(createFixtureServer, { legacy: 'reject' });
  record({ type: 'ready', pid: process.pid });
};

if (import.meta.main) runServer();
