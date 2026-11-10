import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onTestFinished } from 'vitest';
import { GATEWAY_CONFIG_DEFAULTS, UPSTREAM_LIVENESS_DEFAULTS, createChatCompletionsAdapter, createGateway, unauthenticatedSource } from '@momonga/gateway';
import type { FakeClock, FakeScriptedReply } from '@momonga/testkit';
import { startFakeChatCompletions } from '@momonga/testkit';
import type { FakeChatCompletionsServer } from '@momonga/testkit';
import { createGatewayClient } from '../../src/gateway-client.ts';
import type { GatewayClient } from '../../src/gateway-client.ts';
import { capabilitiesFor } from './harness.ts';
import { MODEL_ID } from './scripts.ts';
import { fixedSocket, fixedRolePort } from '@momonga/foundation';

export const KEEP_ALIVE_EVERY_MS = 40;

export const keepAliveOnly: FakeScriptedReply = { kind: 'keep-alive', everyMs: KEEP_ALIVE_EVERY_MS };

export const answer = (text: string): FakeScriptedReply => ({
  kind: 'stream',
  chunks: [{ delta: { role: 'assistant', content: text }, finishReason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
});

export type RealGateway = { client: GatewayClient; upstream: FakeChatCompletionsServer };

const TARGET = MODEL_ID;

export const BREAKER_STAYS_CLOSED_SO_EVERY_REQUEUED_ATTEMPT_REACHES_THE_ONE_TARGET = Number.MAX_SAFE_INTEGER;

export const startRealGateway = async (options: { clock: FakeClock; idleTimeoutMs: number; script: FakeScriptedReply[] }): Promise<RealGateway> => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ka-'));
  fs.chmodSync(dir, 0o700);
  const upstream = await startFakeChatCompletions({ scenario: 'tools-ok', script: options.script });
  const capabilities = capabilitiesFor(100_000);
  const adapter = createChatCompletionsAdapter({ authSource: unauthenticatedSource,
    resolveEndpoint: async () => ({ kind: 'unix', socketPath: upstream.socketPath }),
    capabilities: async () => capabilities,
    schemaDialect: () => capabilities.schemaDialect,
    clock: options.clock,
    liveness: { ...UPSTREAM_LIVENESS_DEFAULTS, idleTimeoutMs: options.idleTimeoutMs },
  });
  const socketPath = path.join(dir, 'gw.sock');
  const gateway = await createGateway({
    config: {
      ...GATEWAY_CONFIG_DEFAULTS,
      models: {
        chains: { [TARGET]: [TARGET] },
        targets: {
          [TARGET]: { kind: 'chat-completions', provider: 'fake', model: 'system', billing: 'metered', maxConcurrency: 1, admissionTimeoutMs: 5_000, counter: createHash('sha256').update(TARGET).digest('hex') },
        },
      },
      breaker: { ...GATEWAY_CONFIG_DEFAULTS.breaker, failureThreshold: BREAKER_STAYS_CLOSED_SO_EVERY_REQUEUED_ATTEMPT_REACHES_THE_ONE_TARGET },
    },
    adapters: { [TARGET]: adapter },
    credentials: [],
    clock: options.clock,
    timers: { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout) },
    dbPath: path.join(dir, 'state', 'gateway.db'),
    hmacKey: Buffer.from('momonga-test-hmac-key-0001-padded-to-32-bytes', 'utf8'),
    socketPath,
    random: () => 0,
    role: fixedRolePort('serving'),
    version: '1.10.0-test',
  });
  const client = createGatewayClient({ resolveSocket: fixedSocket(socketPath), clock: options.clock, version: '7.7.7' });
  onTestFinished(async () => {
    await client.destroy().catch(() => undefined);
    await gateway.close();
    await adapter.close();
    await upstream.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { client, upstream };
};

export const within = <T>(work: Promise<T>, windowMs: number): Promise<{ settled: true; value: T } | { settled: false }> =>
  Promise.race([work.then((value) => ({ settled: true as const, value })), new Promise<{ settled: false }>((resolve) => setTimeout(() => resolve({ settled: false }), windowMs))]);
