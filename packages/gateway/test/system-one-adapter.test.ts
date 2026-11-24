import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { UNCONFIGURED_NETWORK, createFakeClock, createFakeTimers, createScriptedAdapter, textResponseEvents } from '@momonga/testkit';
import { createSystemOneAdapter } from '../src/adapters/system-one/adapter.ts';
import { keyAuthSource, unauthenticatedSource } from '../src/adapters/shared/auth.ts';
import { GatewayError } from '../src/core/errors.ts';
import { createReasoningOriginCodec } from '../src/core/reasoning-origin.ts';
import { createRedactor } from '../src/core/redaction.ts';
import { createRouter } from '../src/core/router.ts';
import { HMAC_KEY, START_MS, buildConfig } from './gateway-helpers.ts';
import type { AdapterRequest, Capabilities, ChoiceQuestionSpec, ProviderAdapter, StreamEvent } from '@momonga/protocol';

const QUESTIONS: ChoiceQuestionSpec = {
  verdict: {
    type: 'choice',
    instructions: 'Decide whether safe or unsafe.',
    criteria: { safe: 'Clearly safe.', unsafe: 'Anything else.' },
  },
  confidence: {
    type: 'choice',
    instructions: 'State confidence.',
    criteria: { high: 'Sure.', medium: 'A little unsure.', low: 'Unsure.' },
  },
};

const servers: http.Server[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop();
    await new Promise<void>((resolve) => (s ? s.close(() => resolve()) : resolve()));
  }
});

const startFakeSystemOne = async (
  handler: (req: { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }) => { status: number; body: string },
): Promise<{ baseUrl: string; seen: { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] }> => {
  const seen: { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const parsed = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
      const entry = { path: req.url ?? '', headers: req.headers, body: parsed };
      seen.push(entry);
      const reply = handler(entry);
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(reply.body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}/api/v1`, seen };
};

const collect = async (iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
};

describe('createSystemOneAdapter', () => {
  it('POSTs /systemone with accept */*, ignores unasked keys, and emits jsonReply enforced (J35-C, J36-A)', async () => {
    const fake = await startFakeSystemOne(() => ({
      status: 200,
      body: JSON.stringify({
        answers: {
          verdict: { type: 'choice', choice: 'safe', confidence: 0.99 },
          confidence: { type: 'choice', choice: 'high', confidence: 0.95 },
          extra_unasked: { type: 'choice', choice: 'ignored' },
        },
        usage: { input_tokens: 42, output_tokens: 0, cost: 0.0001, input_tokens_details: { cached_tokens: 10 } },
      }),
    }));
    const adapter = createSystemOneAdapter({
      resolveEndpoint: async () => ({ kind: 'tcp', baseUrl: fake.baseUrl, network: UNCONFIGURED_NETWORK }),
      capabilities: async () => ({
        outputKind: 'choice',
        contextWindow: 262_144,
        maxOutputTokens: 256,
        toolCalling: 'none',
        structuredOutput: 'json_schema',
        streaming: false,
        stopSequences: false,
        outputBoundField: 'none',
        schemaDialect: 'openai-strict',
        tokenCounting: 'estimated',
        usageReported: true,
        imageInput: false,
        maxConcurrency: 4,
        source: 'config',
      }),
      authSource: keyAuthSource(async () => 'sk-test'),
      clock: { now: () => 1_700_000_000_000 },
      liveness: { headersTimeoutMs: 5_000, idleTimeoutMs: 5_000, timers: { setTimeout, clearTimeout, timeoutSignal: (ms) => AbortSignal.timeout(ms) } },
    });
    const req: AdapterRequest = {
      model: 'typesafe/jev-1.14',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<proposed_tool_call/>' }] }],
      choices: { questions: QUESTIONS },
    };
    const events = await collect(
      adapter.create(req, {
        signal: new AbortController().signal,
        target: { name: 'openrouter/typesafe/jev-1.14', display: 'typesafe/jev-1.14', model: 'typesafe/jev-1.14' },
        attempt: 1,
        reasoningOrigin: { own: () => undefined },
        capabilities: await adapter.capabilities({ name: 'openrouter/typesafe/jev-1.14', display: 'typesafe/jev-1.14', model: 'typesafe/jev-1.14' }),
      }),
    );
    expect(fake.seen).toHaveLength(1);
    expect(fake.seen[0]?.path).toBe('/api/v1/systemone');
    expect(fake.seen[0]?.headers['accept']).toBe('*/*');
    expect(fake.seen[0]?.headers['authorization']).toBe('Bearer sk-test');
    expect(fake.seen[0]?.body).toEqual({
      model: 'typesafe/jev-1.14',
      state: '<proposed_tool_call/>',
      questions: QUESTIONS,
    });
    const completed = events.find((e) => e.type === 'response.completed');
    expect(completed?.type).toBe('response.completed');
    if (completed?.type === 'response.completed') {
      const msg = completed.response.output[0];
      expect(msg?.type).toBe('message');
      if (msg?.type === 'message') {
        expect(msg.content[0]).toEqual({ type: 'output_text', text: JSON.stringify({ verdict: 'safe', confidence: 'high' }), annotations: [] });
      }
      expect(completed.response.usage?.input_tokens).toBe(42);
      expect(completed.response.usage?.input_tokens_details?.cached_tokens).toBe(10);
    }
  });

  it('emits refusal content part while preserving usage when any asked question is refused (J5-A, T14)', async () => {
    const fake = await startFakeSystemOne(() => ({
      status: 200,
      body: JSON.stringify({
        answers: {
          verdict: { type: 'refusal', message: 'cannot decide' },
          confidence: { type: 'choice', choice: 'low' },
        },
        usage: { input_tokens: 30, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } },
      }),
    }));
    const adapter = createSystemOneAdapter({
      resolveEndpoint: async () => ({ kind: 'tcp', baseUrl: fake.baseUrl, network: UNCONFIGURED_NETWORK }),
      capabilities: async () => ({
        outputKind: 'choice',
        contextWindow: 262_144,
        maxOutputTokens: 256,
        toolCalling: 'none',
        structuredOutput: 'json_schema',
        streaming: false,
        stopSequences: false,
        outputBoundField: 'none',
        schemaDialect: 'openai-strict',
        tokenCounting: 'estimated',
        usageReported: true,
        imageInput: false,
        maxConcurrency: 4,
        source: 'config',
      }),
      authSource: unauthenticatedSource,
      clock: { now: () => 1_700_000_000_000 },
      liveness: { headersTimeoutMs: 5_000, idleTimeoutMs: 5_000, timers: { setTimeout, clearTimeout, timeoutSignal: (ms) => AbortSignal.timeout(ms) } },
    });
    const events = await collect(
      adapter.create(
        {
          model: 'typesafe/jev-1.14',
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'state' }] }],
          choices: { questions: QUESTIONS },
        },
        {
          signal: new AbortController().signal,
          target: { name: 'openrouter/typesafe/jev-1.14', display: 'typesafe/jev-1.14', model: 'typesafe/jev-1.14' },
          attempt: 1,
          reasoningOrigin: { own: () => undefined },
          capabilities: await adapter.capabilities({ name: 'openrouter/typesafe/jev-1.14', display: 'typesafe/jev-1.14', model: 'typesafe/jev-1.14' }),
        },
      ),
    );
    const completed = events.find((e) => e.type === 'response.completed');
    expect(completed?.type).toBe('response.completed');
    if (completed?.type === 'response.completed') {
      const msg = completed.response.output[0];
      expect(msg?.type).toBe('message');
      if (msg?.type === 'message') {
        expect(msg.content[0]?.type).toBe('refusal');
      }
      expect(completed.response.usage?.input_tokens).toBe(30);
    }
  });
});

describe('router handling for choice-only models (unary countTokens & start selection)', () => {
  const JEV = 'openrouter/typesafe/jev-1.14';
  const choiceCapabilities: Capabilities = {
    outputKind: 'choice',
    contextWindow: 262_144,
    maxOutputTokens: 256,
    toolCalling: 'none',
    structuredOutput: 'json_schema',
    streaming: false,
    stopSequences: false,
    outputBoundField: 'none',
    schemaDialect: 'openai-strict',
    tokenCounting: 'estimated',
    usageReported: true,
    imageInput: false,
    maxConcurrency: 4,
    source: 'config',
  };

  const makeChoiceAdapter = (): ProviderAdapter => ({
    ...createScriptedAdapter({ calls: [{ events: textResponseEvents({ model: 'typesafe/jev-1.14', chunks: ['{}'] }) }] }),
    kind: 'system-one',
    capabilities: async () => choiceCapabilities,
  });

  const makeRouter = (withText: boolean) => {
    const clock = createFakeClock(START_MS);
    const TEXT = 'openai/gpt-5';
    const base = buildConfig({
      targets: withText ? { [JEV]: { kind: 'system-one' }, [TEXT]: {} } : { [JEV]: { kind: 'system-one' } },
    });
    const targets = {
      ...base.models.targets,
      [JEV]: { ...base.models.targets[JEV]!, outputKind: 'choice' as const },
    };
    const adapters: Record<string, ProviderAdapter> = {
      [JEV]: makeChoiceAdapter(),
      ...(withText ? { [TEXT]: createScriptedAdapter({ calls: [{ events: textResponseEvents({ model: 'gpt-5', chunks: ['ok'] }) }] }) } : {}),
    };
    return createRouter({
      config: { ...base, models: { ...base.models, targets } },
      adapters,
      clock,
      timers: createFakeTimers(clock),
      redactor: createRedactor({ credentials: [] }),
      reasoningOrigin: createReasoningOriginCodec(HMAC_KEY),
    });
  };

  it('skips choice models for router.start() (J9-A, Plan 1.1 #4)', () => {
    expect(makeRouter(false).start()).toBeNull();
    expect(makeRouter(true).start()).toBe('openai/gpt-5');
  });

  it('allows router.narrow with choices:true (countTokens) and refuses without choices:true (J23-A)', async () => {
    const router = makeRouter(false);
    const chain = router.chainOf(JEV);
    const allowed = await router.narrow(JEV, chain, { choices: true });
    expect(allowed.targets).toHaveLength(1);
    expect(allowed.refusals).toEqual([]);

    await expect(router.narrow(JEV, chain, {})).rejects.toMatchObject({
      body: {
        code: 'unsupported_request',
        message: 'typesafe/jev-1.14 only judges approvals; it cannot be the model for a session.',
      },
    });
    try {
      await router.narrow(JEV, chain, {});
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
    }
  });
});
