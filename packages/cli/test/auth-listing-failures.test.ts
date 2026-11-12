import http from 'node:http';
import path from 'node:path';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import type { TestContext } from 'vitest';
import { describe, expect, it } from 'vitest';
import { EXIT_FAILURE, fixedSocket } from '@momonga/foundation';
import type { MomongaModelList } from '@momonga/protocol';
import { createGatewayClient } from '../src/client/gateway-client.ts';
import { authStatus } from '../src/commands/auth.ts';
import { SESSION, runView } from './fake-backend.ts';
import { INITIALIZE, frameOf, resultOf, startAgent, updatesOf } from './acp-harness.ts';
import type { EventPayload } from './acp-harness.ts';
import { account, fakePlanBackend } from './fake-plan-gateway.tsx';

describe('momonga auth status with the accounts read and the model list not read (settlement N-K1)', () => {
  const failing = async (): Promise<MomongaModelList> => {
    throw new Error('the gateway answered 503');
  };

  it('prints the account blocks, then model: unknown with the cause, and exits 1', async () => {
    const written: string[] = [];
    const backend = fakePlanBackend({ accounts: [account({ label: 'home', email: 'home@example.com' })] });
    const code = await authStatus({ stdout: { write: (text) => void written.push(text) }, plan: backend.plan, listing: failing }, { json: false });
    const lines = written.join('').trimEnd().split('\n');
    expect(code).toBe(EXIT_FAILURE);
    expect(lines.some((line) => line.includes('home@example.com'))).toBe(true);
    expect(lines.at(-1)).toBe('model: unknown (the gateway answered 503)');
  });

  it('with --json prints the accounts, no model and the cause, and exits 1', async () => {
    const written: string[] = [];
    const backend = fakePlanBackend({ accounts: [account({ label: 'home' })] });
    const code = await authStatus({ stdout: { write: (text) => void written.push(text) }, plan: backend.plan, listing: failing }, { json: true });
    expect(code).toBe(EXIT_FAILURE);
    expect(JSON.parse(written.join(''))).toMatchObject({ accounts: [{ label: 'home' }], model: null, modelUnknown: 'the gateway answered 503' });
  });
});

const usage = (total: number): EventPayload[] => [
  { type: 'model.responded', step: 1, attempt: 0, response: { status: 'completed', output: [], usage: { input_tokens: total, output_tokens: 0, total_tokens: total } } } as EventPayload,
  { type: 'usage.updated', inputTokens: total, outputTokens: 0, totalTokens: total } as EventPayload,
];

describe('the ACP session and a context window that cannot be read (settlement N-K3, K-14)', () => {
  it('does not keep the failed read: the failed update is a warning with the cause, later updates go on, and the next usage update asks again', async () => {
    const asked: string[] = [];
    const harness = startAgent({
      contextWindowOf: async (model) => {
        asked.push(model);
        if (asked.length === 1) throw new Error('the model list could not be read');
        return 8192;
      },
    });
    await harness.peer.request('initialize', { ...INITIALIZE, clientCapabilities: {} });
    const { sessionId } = resultOf(await harness.peer.request('session/new', { cwd: SESSION.cwd, mcpServers: [] })) as { sessionId: string };
    harness.scripts.set('run-1', async ({ onEvent }) => {
      const events: EventPayload[] = [...usage(1000), { type: 'agent.message.delta', step: 1, attempt: 0, itemId: 'm1', text: 'after' }, ...usage(2000)];
      events.forEach((event, index) => onEvent(frameOf('run-1', index + 1, event)));
      return runView({ id: 'run-1', status: 'COMPLETED' });
    });

    const answer = await harness.peer.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go' }] });

    expect(resultOf(answer)).toEqual({ stopReason: 'end_turn' });
    expect(asked).toEqual([SESSION.model, SESSION.model]);
    const updates = updatesOf(harness.peer.received).filter((update) => update.sessionUpdate !== 'available_commands_update');
    expect(updates.map((update) => update.sessionUpdate)).toEqual(['agent_message_chunk', 'agent_message_chunk', 'usage_update']);
    expect(JSON.stringify(updates[0])).toContain('its context window could not be read (the model list could not be read)');
    expect(updates[1]).toMatchObject({ content: { type: 'text', text: 'after' } });
    expect(updates[2]).toMatchObject({ sessionUpdate: 'usage_update', used: 2000, size: 8192 });
    await harness.peer.close();
  });
});

const CAPABILITIES = {
  contextWindow: 8192,
  maxOutputTokens: 1024,
  toolCalling: 'native',
  structuredOutput: 'none',
  streaming: true,
  stopSequences: true,
  imageInput: false,
  schemaDialect: 'openai',
  tokenCounting: 'estimated',
  usageReported: true,
  maxConcurrency: 1,
  source: 'declared',
};

const MEMBER = { model: 'local/m', counter: 'local/m', billing: 'local', provider: 'local', adapter: 'chat-completions', answers: 'model', upstream: 'm', capabilities: CAPABILITIES };

const ENTRY = { id: 'local/m', object: 'model', provider: 'local', ownName: 'm', billing: 'local', capabilities: CAPABILITIES, state: 'available', chain: [MEMBER] };

const LIST = { object: 'list', data: [ENTRY], start: 'local/m', roles: { compaction: 'local/m' } };

const listedBy = async (context: TestContext, body: unknown): Promise<unknown> => {
  const socketPath = path.join(withTempDir(context), 'g.sock');
  const server = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const client = createGatewayClient({ resolveSocket: fixedSocket(socketPath) });
  registerCleanup(context, async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return client.modelList().catch((error: unknown) => error);
};

describe('the gateway client checks every field of the model list (settlement J-13)', () => {
  it.for([
    ['the entry does not say it is a model', { ...ENTRY, object: undefined }, 'object'],
    ['the provider of a chain member is not text', { ...ENTRY, chain: [{ ...MEMBER, provider: 7 }] }, 'chain'],
  ] as const)('lists an entry as unreadable, naming its field, when %s', async ([_name, entry, field], context) => {
    const listed = await listedBy(context, { ...LIST, data: [entry] });
    expect(listed).toMatchObject({ data: [{ id: 'local/m', capabilities: { toolCalling: { state: 'unavailable', code: 'model_entry_unreadable', message: expect.stringContaining(field) } } }] });
  });

  it('accepts a list that states every field', async (context) => {
    expect(await listedBy(context, LIST)).toEqual(LIST);
  });

  it.for([
    ['the list does not say it is a list', { ...LIST, object: undefined }],
    ['a role names no model', { ...LIST, roles: { compaction: 7 } }],
    ['a role is not one of the roles', { ...LIST, roles: { other: 'local/m' } }],
  ] as const)('refuses a list when %s', async ([_name, body], context) => {
    const refusal = await listedBy(context, body);
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toBe('GET /v1/momonga/models answered a body that is not a model list');
  });
});
