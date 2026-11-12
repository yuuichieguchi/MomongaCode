import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect } from 'vitest';
import { DEFAULT_STOP_VALUES, createUdsClient, gatewayMaxCloseMs, SSE_EVENT_MAX_BYTES, decodeSse, managedServerStopBoundMs, fixedRolePort, fixedSocket } from '@momonga/foundation';
import type { GenerationRole, RolePort, UdsClient, UdsResponse } from '@momonga/foundation';
import { createGateway } from '@momonga/gateway';
import type { FixedModelsOptions, Gateway, GatewayConfig, GatewayOptions, ProviderAdapter } from '@momonga/gateway';
import type { Telemetry } from '@momonga/observability';
import { parseCanon } from '@momonga/protocol';
import type { MomongaModelRoles, StreamEvent, TargetAnswers, TargetBilling } from '@momonga/protocol';
import { CLEANUP_KILL_DEADLINE_MS, createFakeClock, createFakeTimers, createOpenResponsesValidator, createTempDir, testKernelLock } from '@momonga/testkit';
import type { FakeClock, FakeTimers } from '@momonga/testkit';

export const START_MS = 1_800_000_000_000;
export const HMAC_KEY = Buffer.from('momonga-test-hmac-key-0001-padded-to-32-bytes', 'utf8');
export const validator = createOpenResponsesValidator();

export const REAL_FM_STOP_GRACE_MS = 5000;

const CLEANUP_HOOK_BOUND_MS = managedServerStopBoundMs(REAL_FM_STOP_GRACE_MS) + gatewayMaxCloseMs(DEFAULT_STOP_VALUES) + CLEANUP_KILL_DEADLINE_MS;

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'several cleanups failed');
}, CLEANUP_HOOK_BOUND_MS);

export const registerCleanup = (cleanup: () => void | Promise<void>): void => {
  cleanups.push(cleanup);
};

export const makeDir = (): string => {
  const dir = createTempDir();
  fs.chmodSync(dir, 0o700);
  registerCleanup(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

export const TEST_VERSION = '0.0.0-test';

export const stateDbPath = (dir: string): string => {
  const state = path.join(dir, 'state');
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  return path.join(state, 'gateway.db');
};

export type SwitchableRole = RolePort & { become(role: GenerationRole): void };

export const switchableRole = (initial: GenerationRole = 'serving'): SwitchableRole => {
  let role = initial;
  return {
    current: () => role,
    refresh: async () => role,
    become: (next) => {
      role = next;
    },
  };
};

export const counterForTest = (target: string): string => createHash('sha256').update(`test counter of ${target}`).digest('hex');

export const PRIMARY = 'scripted/scripted-primary';

export const NO_START_MODEL = '';

type ConfiguredTarget = GatewayConfig['models']['targets'][string];

export type TargetSpec = {
  kind?: string;
  defaultTag?: string;
  answers?: TargetAnswers;
  billing?: ConfiguredTarget['billing'];
  maxConcurrency?: number;
  admissionTimeoutMs?: number;
  counter?: string;
  idempotencyKeyHeader?: string;
  plan?: ConfiguredTarget['plan'];
  keyGroup?: string;
};

export type ConfigOverrides = {
  targets?: Record<string, TargetSpec>;
  chains?: Record<string, string[]>;
  billingChanges?: ReadonlyArray<{ from: TargetBilling; to: TargetBilling; model?: string }>;
  start?: string;
  roles?: MomongaModelRoles;
  retry?: Partial<GatewayConfig['retry']>;
  breaker?: Partial<GatewayConfig['breaker']>;
  limits?: Partial<GatewayConfig['limits']>;
  idempotency?: Partial<GatewayConfig['idempotency']>;
  closeGraceMs?: number;
  sseKeepAliveMs?: number;
  detachedMaxMs?: number;
};

const identityOf = (canon: string): { provider: string; ownName: string } => {
  const identity = parseCanon(canon);
  if (identity === undefined) throw new Error(`the test model ${JSON.stringify(canon)} is not written as server/name`);
  return identity;
};

export const buildConfig = (overrides: ConfigOverrides = {}): GatewayConfig => {
  const targets: GatewayConfig['models']['targets'] = {};
  const specs = overrides.targets ?? { [PRIMARY]: {} };
  for (const [canon, spec] of Object.entries(specs)) {
    const { provider, ownName } = identityOf(canon);
    targets[canon] = {
      kind: spec.kind ?? 'scripted',
      provider,
      model: ownName,
      ...(spec.defaultTag === undefined ? {} : { defaultTag: spec.defaultTag }),
      ...(spec.answers === undefined ? {} : { answers: spec.answers }),
      billing: spec.billing ?? 'metered',
      maxConcurrency: spec.maxConcurrency ?? 4,
      admissionTimeoutMs: spec.admissionTimeoutMs ?? 5000,
      counter: spec.counter ?? counterForTest(canon),
      ...(spec.idempotencyKeyHeader === undefined ? {} : { idempotencyKeyHeader: spec.idempotencyKeyHeader }),
      ...(spec.plan === undefined ? {} : { plan: spec.plan }),
      ...(spec.keyGroup === undefined ? {} : { keyGroup: spec.keyGroup }),
    };
  }
  return {
    models: {
      targets,
      chains: { ...Object.fromEntries(Object.keys(targets).map((canon) => [canon, [canon]])), ...overrides.chains },
      ...(overrides.billingChanges === undefined ? {} : { billingChanges: overrides.billingChanges.map((change) => ({ ...change })) }),
      ...(overrides.start === undefined ? {} : { start: overrides.start }),
      ...(overrides.roles === undefined ? {} : { roles: overrides.roles }),
    },
    retry: { maxAttempts: 3, totalWaitMs: 84_000, baseMs: 100, maxMs: 10_000, ...overrides.retry },
    breaker: { failureThreshold: 5, openMs: 30_000, ...overrides.breaker },
    limits: { maxBodyBytes: 1_000_000, maxIdempotencyFrameBytes: 8_000_000, readerStallMs: 30_000, ...overrides.limits },
    idempotency: { ttlMs: 60_000, ...overrides.idempotency },
    closeGraceMs: overrides.closeGraceMs ?? 1000,
    sseKeepAliveMs: overrides.sseKeepAliveMs ?? 15_000,
    detachedMaxMs: overrides.detachedMaxMs ?? 1_800_000,
  };
};

export type Harness = {
  gateway: Gateway;
  client: UdsClient;
  clock: FakeClock;
  timers: FakeTimers;
  dir: string;
  socketPath: string;
  dbPath: string;
  model: string;
};

export type HarnessOptions = {
  adapters: Record<string, ProviderAdapter>;
  config?: ConfigOverrides;
  clock?: FakeClock;
  timers?: FakeTimers;
  dir?: string;
  telemetry?: Telemetry;
  hmacKey?: Uint8Array;
  debugTcp?: GatewayOptions['debugTcp'];
  onError?: GatewayOptions['onError'];
  billedCalls?: GatewayOptions['billedCalls'];
  retentionPurge?: GatewayOptions['retentionPurge'];
  traceSpans?: GatewayOptions['traceSpans'];
  credentials?: readonly string[];
  credentialFeed?: GatewayOptions['credentialFeed'];
  priceTable?: FixedModelsOptions['priceTable'];
  random?: () => number;
  role?: RolePort;
  probeFlights?: () => number;
};

export const startGateway = async (options: HarnessOptions): Promise<Harness> => {
  const dir = options.dir ?? makeDir();
  const clock = options.clock ?? createFakeClock(START_MS);
  const timers = options.timers ?? createFakeTimers(clock);
  const socketPath = path.join(dir, 'gw.sock');
  const dbPath = stateDbPath(dir);
  const config = buildConfig(options.config);
  const model = Object.keys(config.models.chains)[0] ?? NO_START_MODEL;
  const gateway = await createGateway({
    lock: testKernelLock(),
    role: options.role ?? fixedRolePort('serving'),
    ...(options.probeFlights === undefined ? {} : { probeFlights: options.probeFlights }),
    random: options.random ?? (() => 0.5),
    credentials: options.credentials ?? [],
    ...(options.credentialFeed === undefined ? {} : { credentialFeed: options.credentialFeed }),
    config,
    adapters: options.adapters,
    clock,
    timers,
    dbPath,
    hmacKey: options.hmacKey ?? HMAC_KEY,
    socketPath,
    pid: process.pid,
    version: TEST_VERSION,
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    ...(options.billedCalls === undefined ? {} : { billedCalls: options.billedCalls }),
    ...(options.retentionPurge === undefined ? {} : { retentionPurge: options.retentionPurge }),
    ...(options.traceSpans === undefined ? {} : { traceSpans: options.traceSpans }),
    ...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
    ...(options.debugTcp === undefined ? {} : { debugTcp: options.debugTcp }),
    ...(options.priceTable === undefined ? {} : { priceTable: options.priceTable }),
  });
  registerCleanup(() => gateway.close());
  const client = createUdsClient(fixedSocket(socketPath), { connectTimeoutMs: 0 });
  registerCleanup(() => client.close());
  return { gateway, client, clock, timers, dir, socketPath, dbPath, model };
};

export const userInput = (text: string) => [
  { type: 'message' as const, role: 'user' as const, content: [{ type: 'input_text' as const, text }] },
];

export const postJson = (
  client: UdsClient,
  urlPath: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<UdsResponse> =>
  client.request({
    method: 'POST',
    path: urlPath,
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

export const getJson = async (client: UdsClient, urlPath: string): Promise<{ status: number; body: any }> => {
  const response = await client.request({ method: 'GET', path: urlPath });
  return { status: response.status, body: await response.json() };
};

export const readJson = async (response: UdsResponse): Promise<{ status: number; headers: Record<string, string>; body: any }> => ({
  status: response.status,
  headers: response.headers,
  body: await response.json(),
});

export type SseFrame = { event: string | undefined; data: any };

export const readSse = async (response: UdsResponse): Promise<SseFrame[]> => {
  expect(response.status).toBe(200);
  expect(response.headers['content-type']).toMatch(/^text\/event-stream/);
  const frames: SseFrame[] = [];
  for await (const frame of decodeSse(response.body, { maxEventBytes: SSE_EVENT_MAX_BYTES })) frames.push({ event: frame.event, data: JSON.parse(frame.data) });
  return frames;
};

export const sseIterator = (response: UdsResponse): AsyncIterator<SseFrame> => {
  const source = decodeSse(response.body, { maxEventBytes: SSE_EVENT_MAX_BYTES });
  return {
    next: async () => {
      const step = await source.next();
      if (step.done === true) return { done: true, value: undefined };
      return { done: false, value: { event: step.value.event, data: JSON.parse(step.value.data) } };
    },
    return: async () => {
      await source.return?.(undefined);
      return { done: true, value: undefined };
    },
  };
};

export const expectErrorBody = (
  body: unknown,
  expected: { type: string; code: string | null; param?: string | null },
): void => {
  expect(Object.keys(body as object)).toEqual(['error']);
  const error = (body as { error: Record<string, unknown> }).error;
  expect(Object.keys(error).sort()).toEqual(['code', 'message', 'param', 'type']);
  expect(error['type']).toBe(expected.type);
  expect(error['code']).toBe(expected.code);
  if (expected.param !== undefined) expect(error['param']).toBe(expected.param);
  expect(typeof error['message']).toBe('string');
  expect((error['message'] as string).length).toBeGreaterThan(0);
  expect(validator.validate('ErrorPayload', error).errors).toEqual([]);
};

export const outputText = (resource: { output: Array<Record<string, any>> }): string =>
  resource.output
    .filter((item) => item['type'] === 'message')
    .flatMap((item) => item['content'] as Array<Record<string, any>>)
    .filter((part) => part['type'] === 'output_text')
    .map((part) => part['text'] as string)
    .join('');

export type { StreamEvent };

export type ServerSpec = TargetSpec & { model: string };

export type TestChain = {
  first: string;
  canon(server: string): string;
  config: { targets: Record<string, TargetSpec>; chains: Record<string, string[]> };
  keyed<T>(byServer: Record<string, T>): Record<string, T>;
};

export const chainOfServers = (servers: Record<string, ServerSpec>): TestChain => {
  const canon = (server: string): string => {
    const spec = Object.hasOwn(servers, server) ? servers[server] : undefined;
    if (spec === undefined) throw new Error(`the test chain has no server named ${JSON.stringify(server)}`);
    return `${server}/${spec.model}`;
  };
  const members = Object.keys(servers).map(canon);
  const [first] = members;
  if (first === undefined) throw new Error('a test chain needs at least one server');
  return {
    first,
    canon,
    config: {
      targets: Object.fromEntries(Object.entries(servers).map(([server, { model: _model, ...spec }]) => [canon(server), spec])),
      chains: { [first]: members },
    },
    keyed: (byServer) => Object.fromEntries(Object.entries(byServer).map(([server, value]) => [canon(server), value])),
  };
};

export type ModelClient = UdsClient & { readonly model: string };

export const clientOfModel = (client: UdsClient, model: string): ModelClient => Object.assign(client, { model });

export type ListedMember = { model: string; counter: string; capabilities: Record<string, unknown>; key?: { group: string }; plan?: { profile: string; account?: string } };

export type ListedEntry = { id: string; capabilities: Record<string, unknown>; chain: ListedMember[] };

export const listedEntryOf = (listing: { data: unknown }, model: string): ListedEntry => {
  const found = (listing.data as ListedEntry[]).find((entry) => entry.id === model);
  if (found === undefined) throw new Error(`the models listing has no entry for ${model}`);
  return found;
};

export const listedMembersOf = (listing: { data: unknown }, model: string): Record<string, ListedMember> => Object.fromEntries(listedEntryOf(listing, model).chain.map((member) => [member.model, member]));

export const listedCountersOf = (listing: { data: unknown }, model: string): Record<string, string> => Object.fromEntries(listedEntryOf(listing, model).chain.map((member) => [member.model, member.counter]));
