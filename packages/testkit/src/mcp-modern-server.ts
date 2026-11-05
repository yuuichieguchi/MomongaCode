import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { type CallToolResult, Server, type Tool } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import {
  FIXTURE_EXTRA_TOOLS_ENV,
  FIXTURE_HOSTILE_TITLE,
  FIXTURE_HOSTILE_TITLE_DESCRIPTION,
  nestedNotSchema,
  requestedExtraTools,
  withIdInputSchema,
  withIdOutputSchema,
  MODERN_FIXTURE_AUDIO_BYTES,
  MODERN_FIXTURE_BLOB_BYTES,
  MODERN_FIXTURE_GRANDCHILD_ENV,
  MODERN_FIXTURE_HOSTILE_DESCRIPTION,
  MODERN_FIXTURE_IMAGE_BYTES,
  MODERN_FIXTURE_LIST_TTL_ENV,
  MODERN_FIXTURE_LONG_TOOL_NAME,
  MODERN_FIXTURE_OVERSIZED_DESCRIPTION_CHARS,
  MODERN_FIXTURE_PAGE_SIZE,
  MODERN_FIXTURE_RECORD_ENV,
  MODERN_FIXTURE_SETSID_GRANDCHILD_ENV,
  MODERN_FIXTURE_STDERR_ENV,
  type ModernFixtureRecord,
} from './mcp-fixtures.ts';
import { engineFailureSchema } from './engine-failure.ts';

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
  {
    name: 'content_kinds',
    description: MODERN_FIXTURE_HOSTILE_DESCRIPTION,
    inputSchema: objectSchema(
      {
        kind: {
          type: 'string',
          enum: ['audio', 'resource_link', 'embedded_text', 'embedded_blob', 'empty', 'mixed', 'error', 'text_and_structured', 'unsorted_structured', 'image_and_structured'],
        },
      },
      ['kind'],
    ),
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'patterned',
    title: 'Patterned Tool',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', pattern: '^[0-9]+$' },
        when: { type: 'string', format: 'vendor-date' },
        nested: { type: 'object', properties: { inner: { type: 'string', pattern: '^z$' } }, additionalProperties: false },
      },
      patternProperties: { '^x-': { type: 'number' } },
      additionalProperties: false,
      required: ['code'],
    },
    annotations: { readOnlyHint: true, destructiveHint: true },
  },
  {
    name: 'oversized',
    description: 'A tool whose input schema exceeds 64 KiB',
    inputSchema: objectSchema({ blob: { type: 'string', description: 'o'.repeat(MODERN_FIXTURE_OVERSIZED_DESCRIPTION_CHARS) } }, []),
  },
  {
    name: 'uncompilable',
    description: 'A tool whose input schema cannot compile',
    inputSchema: { type: 'object', properties: { a: { type: 'strin' } } } as unknown as Tool['inputSchema'],
  },
  { name: 'dotted_name_with-slash', description: 'Collides with dotted.name/with-slash after normalization', inputSchema: objectSchema({}, []) },
];

const EXTRA_TOOLS: Record<string, Tool> = {
  with_id: {
    name: 'with_id',
    description: 'Input and output schemas carry $id',
    inputSchema: withIdInputSchema() as Tool['inputSchema'],
    outputSchema: withIdOutputSchema() as Tool['outputSchema'],
  },
  deep_not_3000: { name: 'deep_not_3000', description: 'A 3000-level not chain', inputSchema: nestedNotSchema(3000) as Tool['inputSchema'] },
  deep_64: { name: 'deep_64', description: 'Nesting depth 64', inputSchema: nestedNotSchema(64) as Tool['inputSchema'] },
  deep_65: { name: 'deep_65', description: 'Nesting depth 65', inputSchema: nestedNotSchema(65) as Tool['inputSchema'] },
  hostile_title: {
    name: 'hostile_title',
    title: FIXTURE_HOSTILE_TITLE,
    description: FIXTURE_HOSTILE_TITLE_DESCRIPTION,
    inputSchema: objectSchema({}, []),
  },
  hostile_text_more: {
    name: 'hostile_text_more',
    title: 'T\udc00U\u009b1mV',
    description: 'A\u009b31mB\ud800C\u001b[31',
    inputSchema: objectSchema({}, []),
  },
  validator_throws: {
    name: 'validator_throws',
    description: 'A 2020-12 schema whose engine is made to throw while validating',
    inputSchema: engineFailureSchema() as unknown as Tool['inputSchema'],
  },
  output_validator_throws: {
    name: 'output_validator_throws',
    description: 'A 2020-12 output schema whose engine is made to throw while validating',
    inputSchema: objectSchema({}, []),
    outputSchema: engineFailureSchema() as unknown as Tool['outputSchema'],
  },
  bad_output_schema: {
    name: 'bad_output_schema',
    description: 'A tool whose output schema does not compile',
    inputSchema: objectSchema({}, []),
    outputSchema: { type: 'object', properties: { a: { type: 'nonsense' } } } as unknown as Tool['outputSchema'],
  },
  if_annotations: {
    name: 'if_annotations',
    description: 'A 2020-12 schema whose if subschema evaluates every property',
    inputSchema: { type: 'object', if: { unevaluatedProperties: {} }, then: {}, unevaluatedProperties: false } as unknown as Tool['inputSchema'],
  },
  format_email: {
    name: 'format_email',
    description: 'A 2020-12 schema with an email format',
    inputSchema: objectSchema({ address: { type: 'string', format: 'email' } }, ['address']),
  },
  schema_draft04: {
    name: 'schema_draft04',
    description: 'A schema that declares draft-04',
    inputSchema: { $schema: 'http://json-schema.org/draft-04/schema#', type: 'object' } as unknown as Tool['inputSchema'],
  },
  schema_2019_09: {
    name: 'schema_2019_09',
    description: 'A schema that declares 2019-09',
    inputSchema: { $schema: 'https://json-schema.org/draft/2019-09/schema', type: 'object' } as unknown as Tool['inputSchema'],
  },
  schema_unknown: {
    name: 'schema_unknown',
    description: 'A schema that declares an unknown dialect',
    inputSchema: { $schema: 'https://example.invalid/dialect/schema', type: 'object' } as unknown as Tool['inputSchema'],
  },
  schema_absent: { name: 'schema_absent', description: 'A schema without $schema', inputSchema: { type: 'object' } as unknown as Tool['inputSchema'] },
  schema_draft07: {
    name: 'schema_draft07',
    description: 'A schema that declares draft-07',
    inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' } as unknown as Tool['inputSchema'],
  },
  remote_ref: {
    name: 'remote_ref',
    description: 'A schema with a $ref to a remote that nobody registered',
    inputSchema: { type: 'object', properties: { a: { $ref: 'https://example.invalid/remote.json' } } } as unknown as Tool['inputSchema'],
  },
  'a.b': { name: 'a.b', description: 'dot', inputSchema: objectSchema({}, []) },
  'a/b': { name: 'a/b', description: 'slash', inputSchema: objectSchema({}, []) },
  a_b: { name: 'a_b', description: 'underscore', inputSchema: objectSchema({}, []) },
};

const extraTools = (): Tool[] =>
  requestedExtraTools(process.env[FIXTURE_EXTRA_TOOLS_ENV]).flatMap((name) => {
    const tool = EXTRA_TOOLS[name];
    return tool === undefined ? [] : [tool];
  });

const base64 = (value: string): string => Buffer.from(value).toString('base64');

const contentKind = (kind: unknown): CallToolResult => {
  switch (kind) {
    case 'audio':
      return { content: [{ type: 'audio', data: base64(MODERN_FIXTURE_AUDIO_BYTES), mimeType: 'audio/wav' }] };
    case 'resource_link':
      return { content: [{ type: 'resource_link', uri: 'file:///fixture/link.txt', name: 'link.txt' }] };
    case 'embedded_text':
      return { content: [{ type: 'resource', resource: { uri: 'file:///fixture/embedded.txt', mimeType: 'text/plain', text: 'embedded text' } }] };
    case 'embedded_blob':
      return {
        content: [
          { type: 'resource', resource: { uri: 'file:///fixture/blob.bin', mimeType: 'application/octet-stream', blob: base64(MODERN_FIXTURE_BLOB_BYTES) } },
        ],
      };
    case 'empty':
      return { content: [] };
    case 'mixed':
      return {
        content: [
          { type: 'text', text: 'first' },
          { type: 'image', data: base64(MODERN_FIXTURE_IMAGE_BYTES), mimeType: 'image/png' },
          { type: 'text', text: 'second' },
        ],
      };
    case 'error':
      return {
        content: [
          { type: 'text', text: 'bad' },
          { type: 'text', text: 'worse' },
        ],
        isError: true,
      };
    case 'text_and_structured':
      return { content: [{ type: 'text', text: 'summary' }], structuredContent: { z: 1, a: 2 } };
    case 'unsorted_structured':
      return { content: [], structuredContent: { z: 1, a: { d: 2, c: 3 } } };
    case 'image_and_structured':
      return { content: [{ type: 'image', data: base64(MODERN_FIXTURE_IMAGE_BYTES), mimeType: 'image/png' }], structuredContent: { b: 1, a: 2 } };
    default:
      return { content: [{ type: 'text', text: `unknown kind ${String(kind)}` }], isError: true };
  }
};

const listTtlMs = (): number | undefined => {
  const raw = process.env[MODERN_FIXTURE_LIST_TTL_ENV];
  return raw === undefined || raw === '' ? undefined : Number(raw);
};

const recordFile = process.env[MODERN_FIXTURE_RECORD_ENV];

const record = (entry: ModernFixtureRecord): void => {
  if (recordFile !== undefined && recordFile !== '') fs.appendFileSync(recordFile, `${JSON.stringify(entry)}\n`);
};

const text = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }] });

const createFixtureServer = (): Server => {
  const tools = [...BASE_TOOLS, ...extraTools()];
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
    const ttlMs = listTtlMs();
    const cache = ttlMs === undefined ? {} : { ttlMs, cacheScope: 'private' as const };
    return next < tools.length ? { tools: page, nextCursor: String(next), ...cache } : { tools: page, ...cache };
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
      case 'content_kinds':
        return contentKind(args['kind']);
      case 'patterned':
        return text(JSON.stringify(args));
      case 'oversized':
      case 'uncompilable':
        return text(name);
      case 'dotted_name_with-slash':
        return text('dotted collision');
      case 'added_later':
        return text('added later');
      case 'with_id':
        return { content: [], structuredContent: { v: String(args['v']) } };
      case 'output_validator_throws':
        return { content: [{ type: 'text', text: 'unchecked' }], structuredContent: { a: 'unchecked' } };
      case 'hostile_title':
      case 'hostile_text_more':
      case 'deep_64':
      case 'deep_65':
      case 'deep_not_3000':
      case 'validator_throws':
      case 'if_annotations':
      case 'format_email':
      case 'schema_draft04':
      case 'schema_2019_09':
      case 'schema_unknown':
      case 'schema_absent':
      case 'schema_draft07':
      case 'remote_ref':
      case 'a.b':
      case 'a/b':
      case 'a_b':
        return text(name);
      default:
        return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true };
    }
  });

  return server;
};

const SETSID_GRANDCHILD = [
  'use POSIX;',
  'POSIX::setsid();',
  'open(my $ready, ">", "$ARGV[0].tmp"); print $ready $$; close($ready); rename("$ARGV[0].tmp", $ARGV[0]);',
  'sleep 1 while 1;',
].join(' ');

const spawnSetsidGrandchild = (readyFile: string): void => {
  const grandchild = spawn('perl', ['-e', SETSID_GRANDCHILD, readyFile], { stdio: ['ignore', 'ignore', 'ignore', 3] });
  record({ type: 'grandchild', pid: grandchild.pid ?? -1 });
};

const runServer = (): void => {
  const stderrLine = process.env[MODERN_FIXTURE_STDERR_ENV];
  if (stderrLine !== undefined && stderrLine !== '') process.stderr.write(`${stderrLine}\n`);
  if (process.env[MODERN_FIXTURE_GRANDCHILD_ENV] === '1') {
    const grandchild = spawn('sleep', ['600'], { stdio: 'ignore' });
    record({ type: 'grandchild', pid: grandchild.pid ?? -1 });
  }
  const setsidReadyFile = process.env[MODERN_FIXTURE_SETSID_GRANDCHILD_ENV];
  if (setsidReadyFile !== undefined && setsidReadyFile !== '') spawnSetsidGrandchild(setsidReadyFile);
  serveStdio(createFixtureServer, { legacy: 'reject' });
  record({ type: 'ready', pid: process.pid });
};

if (import.meta.main) runServer();
