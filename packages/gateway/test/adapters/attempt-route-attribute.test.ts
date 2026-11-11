import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { createOpenResponsesAdapter, unauthenticatedSource } from '@momonga/gateway';
import { createTelemetry } from '@momonga/observability';
import type { OutboundNetwork } from '@momonga/foundation';
import { UNCONFIGURED_NETWORK, UNDICI_DEFAULT_LIVENESS, createFakeClock, openResponsesTextReply, startFakeOpenResponses } from '@momonga/testkit';
import type { UpstreamEndpoint } from '../../src/adapters/shared/http-client.ts';
import { START_MS, postJson, readJson, registerCleanup, startGateway, userInput } from '../gateway-helpers.ts';
import { REMOTE_CAPABILITIES } from '../upstream-gateway-support.ts';

const MODEL = 'scripted/upstream-model';
const REMOTE_ORIGIN = 'http://upstream.example.invalid/v1';

const startRefusingProxy = async (): Promise<number> => {
  const server = net.createServer((socket) => {
    socket.once('data', () => socket.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  registerCleanup(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as net.AddressInfo).port;
};

const viaProxy = (port: number, noProxy?: string): OutboundNetwork => ({
  ...UNCONFIGURED_NETWORK,
  config: {
    ...UNCONFIGURED_NETWORK.config,
    httpProxy: { value: `http://127.0.0.1:${port}`, source: 'HTTP_PROXY' },
    ...(noProxy === undefined ? {} : { noProxy: { value: noProxy, source: 'NO_PROXY' } }),
  },
});

const routeAttributesOf = async (endpoint: UpstreamEndpoint): Promise<Record<string, unknown>> => {
  const memory = new InMemorySpanExporter();
  const telemetry = createTelemetry({
    serviceName: 'momonga-gateway-test',
    serviceVersion: '0.0.0',
    clock: createFakeClock(START_MS),
    exporters: [memory],
    batch: { maxQueueSize: 2048, scheduledDelayMs: 60_000, maxExportBatchSize: 512 },
  });
  registerCleanup(() => telemetry.shutdown());
  const adapter = createOpenResponsesAdapter({
    liveness: UNDICI_DEFAULT_LIVENESS,
    resolveEndpoint: async () => endpoint,
    authSource: unauthenticatedSource,
    capabilities: async () => REMOTE_CAPABILITIES,
    clock: createFakeClock(START_MS),
  });
  registerCleanup(() => adapter.close());
  const { client } = await startGateway({
    adapters: { [MODEL]: adapter },
    telemetry,
    config: { chains: { [MODEL]: [MODEL] }, targets: { [MODEL]: { kind: 'remote' } }, retry: { maxAttempts: 1 } },
  });
  await readJson(await postJson(client, '/v1/responses', { model: MODEL, input: userInput('hi') }));
  await telemetry.forceFlush();
  const [span] = memory.getFinishedSpans().filter((finished) => finished.attributes['gen_ai.operation.name'] === 'chat');
  if (span === undefined) throw new Error('the attempt recorded no chat span');
  return Object.fromEntries(Object.entries(span.attributes).filter(([key]) => key.startsWith('momonga.route')));
};

describe('every model call records the route it used (gateway-core-C29)', () => {
  it('records the proxy route of an attempt sent through a proxy that refuses it', async () => {
    const port = await startRefusingProxy();
    expect(await routeAttributesOf({ kind: 'tcp', baseUrl: REMOTE_ORIGIN, network: viaProxy(port) })).toEqual({ 'momonga.route': 'proxy', 'momonga.route.proxy': `http://127.0.0.1:${port}` });
  });

  it('records the bypass route of an attempt the no-proxy list sends direct', async () => {
    const port = await startRefusingProxy();
    expect(await routeAttributesOf({ kind: 'tcp', baseUrl: REMOTE_ORIGIN, network: viaProxy(port, 'upstream.example.invalid') })).toEqual({ 'momonga.route': 'bypass' });
  });

  it('records the direct route of an attempt to a local socket', async () => {
    const fake = await startFakeOpenResponses({ script: [openResponsesTextReply(['ok'])] });
    registerCleanup(() => fake.close());
    expect(await routeAttributesOf({ kind: 'unix', socketPath: fake.socketPath })).toEqual({ 'momonga.route': 'direct' });
  });
});
