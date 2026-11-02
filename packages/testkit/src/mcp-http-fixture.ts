import { randomUUID } from 'node:crypto';
import type http from 'node:http';
import { readBody, sendJson, startLoopbackServer } from './loopback-http.ts';
import type { LoopbackServer } from './loopback-http.ts';
import type { McpOauthFixture } from './mcp-oauth-fixture.ts';

export const HTTP_FIXTURE_MODERN_VERSION = '2026-07-28';
export const HTTP_FIXTURE_LEGACY_VERSION = '2025-11-25';
export const HTTP_FIXTURE_TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
export const HTTP_FIXTURE_RECONNECT_DELAY_MS = 5;

const ENVELOPE_VERSION = 'io.modelcontextprotocol/protocolVersion';
const ENVELOPE_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo';
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

export type McpHttpFixtureEra = 'modern' | 'legacy';

export type McpHttpFixtureOptions = {
  era: McpHttpFixtureEra;
  oauth?: McpOauthFixture;
  taskPollIntervalMs?: number | null;
  taskTtlMs?: number | null;
  legacyTasks?: true;
  taskCreatedAt?: string;
  taskLastUpdatedAt?: string;
  protectedResourceMetadataPath?: string;
  challengeScope?: string;
  holdSessionDelete?: boolean;
  holdFirstTaskCancel?: boolean;
  path?: string;
};

export type RecordedHttpRequest = {
  httpMethod: string;
  path: string;
  headers: Record<string, string>;
  rpc: { method: string; id: unknown; params: Record<string, unknown> } | undefined;
  status: number;
};

export type FixtureNote =
  | { type: 'aborted'; tool: string; requestId: unknown }
  | { type: 'cancelled'; requestId: unknown }
  | { type: 'task_cancel'; taskId: string }
  | { type: 'session_deleted'; sessionId: string }
  | { type: 'session_delete_held' }
  | { type: 'task_cancel_held'; taskId: string }
  | { type: 'stream_dropped'; tool: string };

export type McpHttpFixture = {
  url: string;
  origin: string;
  records: RecordedHttpRequest[];
  notes: FixtureNote[];
  rpcRecords(method: string): RecordedHttpRequest[];
  until(predicate: () => boolean): Promise<void>;
  expireSessions(): void;
  releaseSlow(): void;
  taskIds(): string[];
  completeTask(taskId: string, text: string, structuredContent?: unknown): void;
  failTask(taskId: string, message: string): void;
  close(): Promise<void>;
};

type Rpc = { jsonrpc: '2.0'; id?: unknown; method: string; params?: Record<string, unknown>; result?: Record<string, unknown> };

type TaskState =
  | { status: 'working'; createdAt: string; asksForName?: true }
  | { status: 'input_required'; createdAt: string }
  | { status: 'completed'; createdAt: string; text: string; structuredContent?: unknown }
  | { status: 'failed'; createdAt: string; message: string }
  | { status: 'cancelled'; createdAt: string };

type StoredEvent = { id: string; data: string };

const objectSchema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
});

const STRUCTURED_SCHEMA = objectSchema({ n: { type: 'number' } }, ['n']);

const TOOLS = [
  { name: 'echo', description: 'Echo the text back', inputSchema: objectSchema({ text: { type: 'string' } }, ['text']), annotations: { readOnlyHint: true } },
  { name: 'slow', description: 'Waits until released or cancelled', inputSchema: objectSchema({}) },
  { name: 'ask_name', description: 'Asks the user for a name over the open response stream', inputSchema: objectSchema({}) },
  { name: 'mrtr_state', description: 'Needs two retries carrying requestState', inputSchema: objectSchema({}) },
  { name: 'mrtr_elicit', description: 'Asks the user for a name', inputSchema: objectSchema({}) },
  { name: 'flaky_read', description: 'Read-only; cuts the stream on its first call', inputSchema: objectSchema({}), annotations: { readOnlyHint: true } },
  { name: 'mrtr_loop', description: 'Never finishes: always asks for another round', inputSchema: objectSchema({}) },
  { name: 'reflect_auth', description: 'Reflects the received Authorization header', inputSchema: objectSchema({}) },
  { name: 'long_task', description: 'Returns a task handle to clients that support tasks', inputSchema: objectSchema({}) },
  { name: 'ask_task', description: 'Returns a task that asks for a name once polled', inputSchema: objectSchema({}) },
  { name: 'mrtr_url', description: 'Asks the user to open a URL', inputSchema: objectSchema({}) },
  { name: 'mrtr_sampling', description: 'Asks for sampling, which no client declared', inputSchema: objectSchema({}) },
  { name: 'structured', description: 'Returns structured content that may break its outputSchema', inputSchema: objectSchema({ valid: { type: 'boolean' } }, ['valid']), outputSchema: STRUCTURED_SCHEMA },
  { name: 'structured_task', description: 'Returns a task whose result is structured', inputSchema: objectSchema({}), outputSchema: STRUCTURED_SCHEMA },
  { name: 'bad_header_number', description: 'x-mcp-header on a number', inputSchema: objectSchema({ n: { type: 'number', 'x-mcp-header': 'N' } }) },
  { name: 'bad_header_empty', description: 'empty x-mcp-header', inputSchema: objectSchema({ s: { type: 'string', 'x-mcp-header': '' } }) },
  { name: 'bad_header_token', description: 'x-mcp-header that is not an HTTP token', inputSchema: objectSchema({ s: { type: 'string', 'x-mcp-header': 'has space' } }) },
  {
    name: 'bad_header_duplicate',
    description: 'two x-mcp-header values that differ only in case',
    inputSchema: objectSchema({ a: { type: 'string', 'x-mcp-header': 'Region' }, b: { type: 'string', 'x-mcp-header': 'region' } }),
  },
  { name: 'bad_header_anyof', description: 'x-mcp-header under anyOf', inputSchema: { type: 'object', properties: { s: { anyOf: [{ type: 'string', 'x-mcp-header': 'S' }] } } } },
  { name: 'bad_header_array', description: 'x-mcp-header under items', inputSchema: objectSchema({ list: { type: 'array', items: { type: 'string', 'x-mcp-header': 'Item' } } }) },
  { name: 'stream_drop', description: 'Cuts the response stream after a progress event', inputSchema: objectSchema({}) },
  {
    name: 'region_echo',
    description: 'Mirrors region into a header',
    inputSchema: objectSchema({ region: { type: 'string', 'x-mcp-header': 'Region' } }, ['region']),
  },
] as const;

const textResult = (text: string): Record<string, unknown> => ({ content: [{ type: 'text', text }] });

const NAME_REQUEST = {
  name: {
    method: 'elicitation/create',
    params: {
      mode: 'form',
      message: 'Please enter your name.',
      requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
  },
} as const;

const headerOf = (req: http.IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

const normalizedHeaders = (req: http.IncomingMessage): Record<string, string> =>
  Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : (value ?? '')]));

export const startMcpHttpFixture = async (options: McpHttpFixtureOptions): Promise<McpHttpFixture> => {
  const mcpPath = options.path ?? '/mcp';
  const records: RecordedHttpRequest[] = [];
  const notes: FixtureNote[] = [];
  const waiters = new Set<() => void>();
  const sessions = new Set<string>();
  const events = new Map<string, StoredEvent[]>();
  const tasks = new Map<string, TaskState>();
  const slowGates = new Set<() => void>();
  let firstTaskCancelHeld = false;
  const clientReplies = new Map<string, (result: Record<string, unknown> | undefined) => void>();
  let server: LoopbackServer | undefined;
  let streamCounter = 0;
  let taskCounter = 0;
  let loopCounter = 0;
  let flakyCalls = 0;

  const changed = (): void => {
    for (const waiter of [...waiters]) waiter();
  };
  const note = (entry: FixtureNote): void => {
    notes.push(entry);
    changed();
  };
  const record = (entry: RecordedHttpRequest): void => {
    records.push(entry);
    changed();
  };
  const origin = (): string => (server as LoopbackServer).origin;
  const resourceUrl = (): string => `${origin()}${mcpPath}`;

  const rpcError = (id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> => ({
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });

  const complete = (id: unknown, result: Record<string, unknown>): Record<string, unknown> => ({
    jsonrpc: '2.0',
    id,
    result: options.era === 'modern' ? { resultType: 'complete', ...result } : result,
  });

  const taskView = (taskId: string, state: TaskState): Record<string, unknown> => ({
    taskId,
    status: state.status,
    createdAt: state.createdAt,
    lastUpdatedAt: options.taskLastUpdatedAt ?? state.createdAt,
    ttlMs: options.taskTtlMs ?? null,
    ...(options.taskPollIntervalMs === null ? {} : { pollIntervalMs: options.taskPollIntervalMs ?? 1 }),
    ...(state.status === 'input_required' ? { inputRequests: NAME_REQUEST } : {}),
    ...(state.status === 'completed'
      ? { result: { ...textResult(state.text), ...(state.structuredContent === undefined ? {} : { structuredContent: state.structuredContent }) } }
      : {}),
    ...(state.status === 'failed' ? { statusMessage: state.message, error: { code: -32603, message: state.message } } : {}),
  });

  const unauthorized = (req: http.IncomingMessage, res: http.ServerResponse, attempt: Omit<RecordedHttpRequest, 'status'>): boolean => {
    if (options.oauth === undefined) return false;
    const presented = /^Bearer (.+)$/.exec(headerOf(req, 'authorization') ?? '')?.[1];
    const verdict = options.oauth.verify(presented, resourceUrl());
    if (verdict === 'valid') return false;
    record({ ...attempt, status: 401 });
    const metadataPath = options.protectedResourceMetadataPath ?? `/.well-known/oauth-protected-resource${mcpPath}`;
    const metadata = `resource_metadata="${origin()}${metadataPath}"${options.challengeScope === undefined ? '' : `, scope="${options.challengeScope}"`}`;
    const challenge = presented === undefined ? `Bearer ${metadata}` : `Bearer error="invalid_token", ${metadata}`;
    res.writeHead(401, { 'www-authenticate': challenge, 'content-type': 'application/json' });
    res.end(JSON.stringify(rpcError(undefined, -32001, 'unauthorized')));
    return true;
  };

  const startSse = (res: http.ServerResponse): void => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
    res.write(': stream open\n\n');
  };

  const sendEvent = (res: http.ServerResponse, payload: unknown, id?: string): void => {
    res.write(`${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(payload)}\n\n`);
  };

  const closedOf = (res: http.ServerResponse): Promise<void> => new Promise((resolve) => res.once('close', resolve));

  const awaitSlow = (res: http.ServerResponse): Promise<'released' | 'closed'> =>
    new Promise((resolve) => {
      const gate = (): void => resolve('released');
      slowGates.add(gate);
      void closedOf(res).then(() => {
        slowGates.delete(gate);
        resolve('closed');
      });
    });

  const modernCaps = (rpc: Rpc): Record<string, unknown> => {
    const meta = rpc.params?.['_meta'] as Record<string, unknown> | undefined;
    return (meta?.[ENVELOPE_CAPABILITIES] as Record<string, unknown> | undefined) ?? {};
  };

  const clientSupportsTasks = (rpc: Rpc): boolean => {
    const extensions = modernCaps(rpc)['extensions'] as Record<string, unknown> | undefined;
    return extensions?.[HTTP_FIXTURE_TASKS_EXTENSION] !== undefined;
  };

  const callTool = async (rpc: Rpc, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const params = rpc.params ?? {};
    const name = String(params['name']);
    const args = (params['arguments'] ?? {}) as Record<string, unknown>;
    const modern = options.era === 'modern';
    switch (name) {
      case 'echo':
        sendJson(res, 200, complete(rpc.id, textResult(String(args['text']))));
        return;
      case 'region_echo': {
        if (modern && headerOf(req, 'mcp-param-region') !== args['region']) {
          sendJson(res, 400, rpcError(rpc.id, HEADER_MISMATCH, 'Mcp-Param-Region does not match the body'));
          return;
        }
        sendJson(res, 200, complete(rpc.id, textResult(`region ${String(args['region'])}`)));
        return;
      }
      case 'slow': {
        startSse(res);
        const outcome = await awaitSlow(res);
        if (outcome === 'closed') {
          note({ type: 'aborted', tool: 'slow', requestId: rpc.id });
          return;
        }
        sendEvent(res, complete(rpc.id, textResult('slow done')));
        res.end();
        return;
      }
      case 'ask_name': {
        startSse(res);
        sendEvent(res, { jsonrpc: '2.0', id: 'ask-1', method: 'elicitation/create', params: { ...NAME_REQUEST.name.params } });
        const answer = await new Promise<Record<string, unknown> | undefined>((resolve) => {
          clientReplies.set('ask-1', resolve);
          void closedOf(res).then(() => resolve(undefined));
        });
        clientReplies.delete('ask-1');
        if (answer === undefined) {
          note({ type: 'aborted', tool: 'ask_name', requestId: rpc.id });
          return;
        }
        const content = answer['content'] as { name?: string } | undefined;
        sendEvent(res, complete(rpc.id, textResult(`hello ${content?.name ?? 'nobody'}`)));
        res.end();
        return;
      }
      case 'mrtr_state': {
        const state = params['requestState'];
        if (state === undefined) {
          sendJson(res, 200, { jsonrpc: '2.0', id: rpc.id, result: { resultType: 'input_required', requestState: 'round-1' } });
          return;
        }
        if (state === 'round-1') {
          sendJson(res, 200, { jsonrpc: '2.0', id: rpc.id, result: { resultType: 'input_required', requestState: 'round-2' } });
          return;
        }
        sendJson(res, 200, complete(rpc.id, textResult(state === 'round-2' ? 'mrtr complete' : `unexpected state ${String(state)}`)));
        return;
      }
      case 'flaky_read': {
        flakyCalls += 1;
        if (flakyCalls === 1) {
          startSse(res);
          note({ type: 'stream_dropped', tool: 'flaky_read' });
          res.destroy();
          return;
        }
        sendJson(res, 200, complete(rpc.id, textResult(`flaky ok after ${flakyCalls} calls`)));
        return;
      }
      case 'mrtr_loop': {
        loopCounter += 1;
        sendJson(res, 200, { jsonrpc: '2.0', id: rpc.id, result: { resultType: 'input_required', requestState: `loop-${loopCounter}` } });
        return;
      }
      case 'reflect_auth': {
        const reflected = headerOf(req, 'authorization') ?? 'none';
        sendJson(res, 200, complete(rpc.id, { ...textResult(`received ${reflected}`), isError: true }));
        return;
      }
      case 'mrtr_elicit': {
        const caps = modernCaps(rpc);
        const supported = caps['elicitation'] !== undefined;
        if (!supported) {
          sendJson(res, 200, complete(rpc.id, textResult('elicitation unavailable')));
          return;
        }
        const responses = params['inputResponses'] as Record<string, { content?: { name?: string } }> | undefined;
        const name_ = responses?.['who']?.content?.name;
        if (name_ !== undefined) {
          sendJson(res, 200, complete(rpc.id, textResult(`hello ${name_}`)));
          return;
        }
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            resultType: 'input_required',
            inputRequests: {
              who: {
                method: 'elicitation/create',
                params: {
                  mode: 'form',
                  message: 'Who are you?',
                  requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
                },
              },
            },
            requestState: 'ask',
          },
        });
        return;
      }
      case 'mrtr_url': {
        const responses = params['inputResponses'] as Record<string, { action?: string }> | undefined;
        if (responses?.['link']?.action !== undefined) {
          sendJson(res, 200, complete(rpc.id, textResult(`link ${responses['link'].action}`)));
          return;
        }
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            resultType: 'input_required',
            inputRequests: { link: { method: 'elicitation/create', params: { mode: 'url', message: 'Connect your account.', url: 'https://example.test/connect?s=1' } } },
            requestState: 'link',
          },
        });
        return;
      }
      case 'mrtr_sampling': {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            resultType: 'input_required',
            inputRequests: { pick: { method: 'sampling/createMessage', params: { messages: [], maxTokens: 10 } } },
          },
        });
        return;
      }
      case 'structured': {
        sendJson(res, 200, complete(rpc.id, { ...textResult('structured'), structuredContent: args['valid'] === true ? { n: 1 } : { n: 'one' } }));
        return;
      }
      case 'ask_task':
      case 'structured_task':
      case 'long_task': {
        if (!(modern ? clientSupportsTasks(rpc) : options.legacyTasks === true)) {
          sendJson(res, 200, complete(rpc.id, textResult('tasks unsupported')));
          return;
        }
        taskCounter += 1;
        const taskId = `task-${taskCounter}`;
        const state: TaskState = { status: 'working', createdAt: options.taskCreatedAt ?? new Date().toISOString(), ...(name === 'ask_task' ? { asksForName: true as const } : {}) };
        tasks.set(taskId, state);
        sendJson(res, 200, { jsonrpc: '2.0', id: rpc.id, result: { resultType: 'task', ...taskView(taskId, state) } });
        changed();
        return;
      }
      case 'stream_drop': {
        streamCounter += 1;
        const stream = `s${streamCounter}`;
        startSse(res);
        const progress = { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'p', progress: 1 } };
        if (modern) {
          sendEvent(res, progress);
          note({ type: 'stream_dropped', tool: 'stream_drop' });
          res.destroy();
          return;
        }
        const sessionId = headerOf(req, 'mcp-session-id') as string;
        const stored: StoredEvent[] = [
          { id: `${stream}:0`, data: '' },
          { id: `${stream}:1`, data: JSON.stringify(progress) },
          { id: `${stream}:2`, data: JSON.stringify(complete(rpc.id, textResult('resumed result'))) },
        ];
        events.set(`${sessionId}/${stream}`, stored);
        res.write(`id: ${stored[0]?.id}\nretry: ${HTTP_FIXTURE_RECONNECT_DELAY_MS}\ndata:\n\n`);
        res.write(`id: ${stored[1]?.id}\ndata: ${stored[1]?.data}\n\n`);
        note({ type: 'stream_dropped', tool: 'stream_drop' });
        res.end();
        return;
      }
      default:
        sendJson(res, 200, complete(rpc.id, { ...textResult(`unknown tool ${name}`), isError: true }));
    }
  };

  const handleTasks = (rpc: Rpc, res: http.ServerResponse): void => {
    const taskId = String(rpc.params?.['taskId']);
    const state = tasks.get(taskId);
    if (state === undefined) {
      sendJson(res, 200, rpcError(rpc.id, -32602, 'Failed to retrieve task: Task not found'));
      return;
    }
    if (rpc.method === 'tasks/get') {
      const view = state.status === 'working' && state.asksForName === true ? { status: 'input_required' as const, createdAt: state.createdAt } : state;
      if (view !== state) tasks.set(taskId, view);
      sendJson(res, 200, complete(rpc.id, taskView(taskId, view)));
      return;
    }
    if (rpc.method === 'tasks/update' && state.status === 'input_required') {
      const responses = rpc.params?.['inputResponses'] as Record<string, { content?: { name?: string } }> | undefined;
      tasks.set(taskId, { status: 'completed', createdAt: state.createdAt, text: `hello ${responses?.['name']?.content?.name ?? 'nobody'}` });
      changed();
    }
    if (rpc.method === 'tasks/cancel' && options.holdFirstTaskCancel === true && !firstTaskCancelHeld) {
      firstTaskCancelHeld = true;
      note({ type: 'task_cancel_held', taskId });
      return;
    }
    if (rpc.method === 'tasks/cancel') {
      note({ type: 'task_cancel', taskId });
      tasks.set(taskId, { status: 'cancelled', createdAt: state.createdAt });
      sendJson(res, 200, complete(rpc.id, {}));
      return;
    }
    sendJson(res, 200, complete(rpc.id, {}));
  };

  const handleModern = async (rpc: Rpc, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const meta = rpc.params?.['_meta'] as Record<string, unknown> | undefined;
    const claimed = meta?.[ENVELOPE_VERSION];
    const headerVersion = headerOf(req, 'mcp-protocol-version');
    if (claimed !== HTTP_FIXTURE_MODERN_VERSION) {
      sendJson(res, 400, rpcError(rpc.id, UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
        supported: [HTTP_FIXTURE_MODERN_VERSION],
        requested: String(claimed),
      }));
      return;
    }
    if (headerVersion !== claimed || headerOf(req, 'mcp-method') !== rpc.method) {
      sendJson(res, 400, rpcError(rpc.id, HEADER_MISMATCH, 'Header mismatch'));
      return;
    }
    const expectedName = rpc.method === 'tools/call' ? rpc.params?.['name'] : rpc.method.startsWith('tasks/') ? rpc.params?.['taskId'] : undefined;
    if (expectedName !== undefined && headerOf(req, 'mcp-name') !== expectedName) {
      sendJson(res, 400, rpcError(rpc.id, HEADER_MISMATCH, 'Mcp-Name does not match the body'));
      return;
    }
    switch (rpc.method) {
      case 'server/discover':
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            resultType: 'complete',
            supportedVersions: [HTTP_FIXTURE_MODERN_VERSION],
            capabilities: { tools: {}, extensions: { [HTTP_FIXTURE_TASKS_EXTENSION]: {} } },
            _meta: { [SERVER_INFO_KEY]: { name: 'momonga-http-fixture', version: '1.0.0' } },
            instructions: 'Modern HTTP fixture',
            ttlMs: 0,
            cacheScope: 'private',
          },
        });
        return;
      case 'tools/list':
        sendJson(res, 200, complete(rpc.id, { tools: TOOLS, ttlMs: 0, cacheScope: 'private' }));
        return;
      case 'tools/call':
        await callTool(rpc, req, res);
        return;
      case 'tasks/get':
      case 'tasks/update':
      case 'tasks/cancel':
        handleTasks(rpc, res);
        return;
      default:
        sendJson(res, 404, rpcError(rpc.id, -32601, 'Method not found'));
    }
  };

  const handleLegacy = async (rpc: Rpc | undefined, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (rpc?.method === 'initialize') {
      const sessionId = randomUUID();
      sessions.add(sessionId);
      sendJson(
        res,
        200,
        {
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            protocolVersion: HTTP_FIXTURE_LEGACY_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'momonga-http-fixture', version: '1.0.0' },
            instructions: 'Legacy HTTP fixture',
          },
        },
        { 'mcp-session-id': sessionId },
      );
      return;
    }
    const sessionId = headerOf(req, 'mcp-session-id');
    if (sessionId === undefined) {
      sendJson(res, 400, rpcError(undefined, -32000, 'Bad Request: Server not initialized'));
      return;
    }
    if (!sessions.has(sessionId)) {
      sendJson(res, 404, rpcError(undefined, -32001, 'Session not found'));
      return;
    }
    if (rpc === undefined) {
      res.writeHead(400).end();
      return;
    }
    if (rpc.method === undefined) {
      clientReplies.get(String(rpc.id))?.(rpc.result);
      res.writeHead(202).end();
      return;
    }
    if (rpc.method === 'notifications/initialized') {
      res.writeHead(202).end();
      return;
    }
    if (rpc.method === 'notifications/cancelled') {
      note({ type: 'cancelled', requestId: rpc.params?.['requestId'] });
      for (const gate of [...slowGates]) gate();
      res.writeHead(202).end();
      return;
    }
    if (rpc.method === 'tools/list') {
      sendJson(res, 200, complete(rpc.id, { tools: TOOLS }));
      return;
    }
    if (rpc.method === 'tools/call') {
      await callTool(rpc, req, res);
      return;
    }
    if (rpc.method.startsWith('tasks/') && options.legacyTasks === true) {
      handleTasks(rpc, res);
      return;
    }
    sendJson(res, 200, rpcError(rpc.id, -32601, 'Method not found'));
  };

  const replayFrom = (req: http.IncomingMessage, res: http.ServerResponse, sessionId: string): void => {
    const lastEventId = headerOf(req, 'last-event-id') as string;
    const [stream, indexText] = lastEventId.split(':');
    const stored = events.get(`${sessionId}/${stream}`);
    if (stored === undefined) {
      res.writeHead(404).end();
      return;
    }
    startSse(res);
    for (const event of stored.filter((entry) => Number(entry.id.split(':')[1]) > Number(indexText))) {
      res.write(`id: ${event.id}\ndata: ${event.data}\n\n`);
    }
    res.end();
  };

  server = await startLoopbackServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin());
    const httpMethod = req.method ?? 'GET';
    const metadataRoute = options.protectedResourceMetadataPath ?? '/.well-known/oauth-protected-resource';
    const servesMetadata = options.protectedResourceMetadataPath === undefined ? url.pathname.startsWith(metadataRoute) : url.pathname === metadataRoute;
    if (httpMethod === 'GET' && servesMetadata && options.oauth !== undefined) {
      sendJson(res, 200, { resource: resourceUrl(), authorization_servers: [options.oauth.issuer], scopes_supported: ['mcp'] });
      return;
    }
    if (url.pathname !== mcpPath) {
      res.writeHead(404).end();
      return;
    }
    const body = httpMethod === 'POST' ? await readBody(req) : '';
    const rpc = body === '' ? undefined : (JSON.parse(body) as Rpc);
    const base = {
      httpMethod,
      path: url.pathname,
      headers: normalizedHeaders(req),
      rpc: rpc === undefined ? undefined : { method: rpc.method, id: rpc.id, params: rpc.params ?? {} },
    };
    if (unauthorized(req, res, base)) return;
    const recorded: RecordedHttpRequest = { ...base, status: 0 };
    record(recorded);
    res.once('close', () => {
      recorded.status = res.statusCode;
      changed();
    });
    if (httpMethod === 'POST') {
      if (rpc === undefined) {
        res.writeHead(400).end();
        return;
      }
      if (options.era === 'modern') await handleModern(rpc, req, res);
      else await handleLegacy(rpc, req, res);
      return;
    }
    if (options.era === 'legacy' && httpMethod === 'GET' && headerOf(req, 'last-event-id') !== undefined) {
      const sessionId = headerOf(req, 'mcp-session-id');
      if (sessionId === undefined || !sessions.has(sessionId)) {
        res.writeHead(404).end();
        return;
      }
      replayFrom(req, res, sessionId);
      return;
    }
    if (options.era === 'legacy' && httpMethod === 'DELETE') {
      if (options.holdSessionDelete === true) {
        note({ type: 'session_delete_held' });
        return;
      }
      const sessionId = headerOf(req, 'mcp-session-id');
      if (sessionId !== undefined && sessions.delete(sessionId)) {
        note({ type: 'session_deleted', sessionId });
        res.writeHead(200).end();
        return;
      }
      res.writeHead(404).end();
      return;
    }
    res.writeHead(405, { allow: 'POST' }).end();
  });

  return {
    url: resourceUrl(),
    origin: origin(),
    records,
    notes,
    rpcRecords: (method) => records.filter((entry) => entry.rpc?.method === method),
    until: (predicate) =>
      new Promise<void>((resolve) => {
        if (predicate()) {
          resolve();
          return;
        }
        const check = (): void => {
          if (!predicate()) return;
          waiters.delete(check);
          resolve();
        };
        waiters.add(check);
      }),
    expireSessions: () => sessions.clear(),
    releaseSlow: () => {
      for (const gate of [...slowGates]) gate();
    },
    taskIds: () => [...tasks.keys()],
    completeTask: (taskId, text, structuredContent) => {
      const state = tasks.get(taskId);
      if (state !== undefined) tasks.set(taskId, { status: 'completed', createdAt: state.createdAt, text, ...(structuredContent === undefined ? {} : { structuredContent }) });
    },
    failTask: (taskId, message) => {
      const state = tasks.get(taskId);
      if (state !== undefined) tasks.set(taskId, { status: 'failed', createdAt: state.createdAt, message });
    },
    close: () => (server as LoopbackServer).close(),
  };
};
