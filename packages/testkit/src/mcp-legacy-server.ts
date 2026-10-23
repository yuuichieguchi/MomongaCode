import readline from 'node:readline';
import { FIXTURE_EXTRA_TOOLS_ENV, LEGACY_FIXTURE_PROTOCOL_VERSION, requestedExtraTools, withIdInputSchema, withIdOutputSchema } from './mcp-fixtures.ts';

type JsonRpcRequest = { jsonrpc: '2.0'; id?: number | string; method: string; params?: Record<string, unknown> };

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the text back',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'add',
    description: 'Add two numbers',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  },
  { name: 'bare', inputSchema: { type: 'object', properties: {} } },
];

const WITH_ID_TOOL = { name: 'with_id', description: 'Input and output schemas carry $id', inputSchema: withIdInputSchema(), outputSchema: withIdOutputSchema() };

const listedTools = (): Array<Record<string, unknown>> =>
  requestedExtraTools(process.env[FIXTURE_EXTRA_TOOLS_ENV]).includes('with_id') ? [...TOOLS, WITH_ID_TOOL] : TOOLS;

const write = (message: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const respond = (id: number | string, result: Record<string, unknown>): void => write({ jsonrpc: '2.0', id, result });

const fail = (id: number | string, code: number, message: string): void =>
  write({ jsonrpc: '2.0', id, error: { code, message } });

const callTool = (params: Record<string, unknown>): Record<string, unknown> => {
  const args = (params['arguments'] ?? {}) as Record<string, unknown>;
  switch (params['name']) {
    case 'echo':
      return { content: [{ type: 'text', text: String(args['text']) }] };
    case 'add':
      return { content: [{ type: 'text', text: String(Number(args['a']) + Number(args['b'])) }] };
    case 'with_id':
      return { content: [], structuredContent: { v: String(args['v']) } };
    case 'bare':
      return { content: [{ type: 'text', text: 'bare' }] };
    default:
      return { content: [{ type: 'text', text: `unknown tool ${String(params['name'])}` }], isError: true };
  }
};

const handle = (request: JsonRpcRequest): void => {
  if (request.id === undefined) return;
  switch (request.method) {
    case 'initialize':
      respond(request.id, {
        protocolVersion: LEGACY_FIXTURE_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'momonga-legacy-fixture', version: '1.0.0' },
      });
      return;
    case 'ping':
      respond(request.id, {});
      return;
    case 'tools/list':
      respond(request.id, { tools: listedTools() });
      return;
    case 'tools/call':
      respond(request.id, callTool(request.params ?? {}));
      return;
    default:
      fail(request.id, -32601, `Method not found: ${request.method}`);
  }
};

const runServer = (): void => {
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (line.trim() === '') return;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    handle(request);
  });
  lines.on('close', () => process.exit(0));
};

if (import.meta.main) runServer();
