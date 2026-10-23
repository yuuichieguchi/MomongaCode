import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, expect } from 'vitest';
import { createUdsClient } from '@momonga/foundation';
import type { UdsClient } from '@momonga/foundation';
import * as protocol from '@momonga/protocol';
import type { PermissionMode, PermissionOption, RunEvent, RunEventPayload } from '@momonga/protocol';
import * as runtime from '@momonga/runtime';
import type { ToolRuntimePort, Worker, WorkerOptions } from '@momonga/runtime';
import type { SandboxPolicy } from '@momonga/sandbox';
import { openRuntimeStore } from '@momonga/store';
import type { Claim, RuntimeStore, Session } from '@momonga/store';
import { createFakeClock, createFakeTimers } from '@momonga/testkit';
import type { FakeClock, FakeTimers } from '@momonga/testkit';
import { createToolExecutor, createToolRegistry } from '@momonga/tools';
import type { ToolSessionState } from '@momonga/tools';
import { within } from '../worker/deferred.ts';
import { createFakeGateway } from '../worker/fake-gateway.ts';
import type { FakeGateway } from '../worker/fake-gateway.ts';
import { createFakeSettings } from '../worker/fake-settings.ts';
import type { FakeSettings } from '../worker/fake-settings.ts';
import { createFakeToolbox } from '../worker/fake-tools.ts';
import type { FakeToolbox } from '../worker/fake-tools.ts';
import { createFakeTracer } from '../worker/fake-tracer.ts';
import { capabilitiesFor, createFakeInstructions, fakeSandbox, testSystemPrompt } from '../worker/harness.ts';

export const START_MS = 1_800_000_000_000;
export const LEASE_MS = 30_000;
export const SERVICE_VERSION = '0.0.0-test';
export const MODEL_ALIAS = 'fm';
export const OTHER_ALIAS = 'fm-large';
export const DECLARED_CREDENTIAL = 'FM_UPSTREAM_VALUE';
export const HOUR_MS = 3_600_000;
export const DEFAULT_TIMEOUT_MS = 6 * HOUR_MS;
export const DEFAULT_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_LIMITS = { maxSteps: 50, maxTotalTokens: 1_000_000, approvalTtlMs: DEFAULT_TTL_MS, loopThreshold: 3 };
export const SOCKET_PATH_LIMIT = 104;

type Cleanup = () => void | Promise<void>;

const cleanups: Cleanup[] = [];

afterEach(async () => {
  const pending = cleanups.splice(0).reverse();
  const errors: unknown[] = [];
  for (const cleanup of pending) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw errors[0];
});

export const onCleanup = (cleanup: Cleanup): void => void cleanups.push(cleanup);

export type Layout = { root: string; home: string; momonga: string; runDir: string; project: string; projectReal: string; socketPath: string; dbPath: string };

export const makeLayout = (): Layout => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ms-')));
  onCleanup(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'h');
  const momonga = path.join(home, '.momonga');
  const runDir = path.join(momonga, 'run');
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(momonga, 0o700);
  fs.chmodSync(runDir, 0o700);
  const project = path.join(root, 'p');
  fs.mkdirSync(project);
  const socketPath = path.join(runDir, 'r.sock');
  if (Buffer.byteLength(socketPath) >= SOCKET_PATH_LIMIT - 4) throw new Error(`test socket path is too long: ${socketPath}`);
  return { root, home, momonga, runDir, project, projectReal: fs.realpathSync(project), socketPath, dbPath: path.join(root, 's.db') };
};

export type SettingsDefault = { defaultMode?: PermissionMode; defaultModeOrigin?: 'user' | 'project' | 'local' };

export type FakePorts = {
  settingsByCwd: Map<string, SettingsDefault>;
  settingsCalls: string[];
  credentialEnvNames: () => readonly string[];
  modelAliases: () => Promise<readonly string[]>;
  settingsFor: (cwd: string) => Promise<SettingsDefault>;
};

export const createFakePorts = (): FakePorts => {
  const settingsByCwd = new Map<string, SettingsDefault>();
  const settingsCalls: string[] = [];
  return {
    settingsByCwd,
    settingsCalls,
    credentialEnvNames: () => [DECLARED_CREDENTIAL],
    modelAliases: async () => [MODEL_ALIAS, OTHER_ALIAS],
    settingsFor: async (cwd) => {
      settingsCalls.push(cwd);
      const real = fs.existsSync(cwd) ? fs.realpathSync(cwd) : cwd;
      return settingsByCwd.get(real) ?? {};
    },
  };
};

const ajv = new Ajv2020.default({ strict: false, allErrors: true });
addFormats.default(ajv);
const validators = new Map<string, ValidateFunction>();
let schemasRegistered = false;

const runApiSchemas = (): Record<string, Record<string, unknown>> => {
  const schemas = (protocol as Record<string, unknown>)['RUN_API_SCHEMAS'];
  if (schemas === undefined || schemas === null || typeof schemas !== 'object') throw new Error('@momonga/protocol does not export RUN_API_SCHEMAS');
  return schemas as Record<string, Record<string, unknown>>;
};

export const validatorFor = (name: string): ValidateFunction => {
  const cached = validators.get(name);
  if (cached !== undefined) return cached;
  const schemas = runApiSchemas();
  if (!schemasRegistered) {
    for (const schema of Object.values(schemas)) if (typeof schema['$id'] === 'string' && ajv.getSchema(schema['$id']) === undefined) ajv.addSchema(schema);
    schemasRegistered = true;
  }
  const schema = schemas[name];
  if (schema === undefined) throw new Error(`RUN_API_SCHEMAS has no ${name} schema`);
  const validate = typeof schema['$id'] === 'string' ? (ajv.getSchema(schema['$id']) as ValidateFunction) : ajv.compile(schema);
  validators.set(name, validate);
  return validate;
};

export const expectSchema = (name: string, value: unknown): void => {
  const validate = validatorFor(name);
  const valid = validate(value);
  if (!valid) throw new Error(`${name} schema rejected ${JSON.stringify(value)}: ${ajv.errorsText(validate.errors)}`);
};

const VIEW_KEYS: Record<string, string> = { session: 'SessionView', run: 'RunView', approval: 'ApprovalView' };
const LIST_KEYS: Record<string, string> = { sessions: 'SessionView', runs: 'RunView', approvals: 'ApprovalView' };

export const validateJsonBody = (status: number, body: unknown): void => {
  if (body === undefined) return;
  if (status >= 400) {
    expectSchema('ErrorBody', body);
    return;
  }
  if (typeof body !== 'object' || body === null) return;
  for (const [key, name] of Object.entries(VIEW_KEYS)) if (key in body) expectSchema(name, (body as Record<string, unknown>)[key]);
  for (const [key, name] of Object.entries(LIST_KEYS)) {
    if (!(key in body)) continue;
    const list = (body as Record<string, unknown>)[key];
    expect(Array.isArray(list)).toBe(true);
    for (const item of list as unknown[]) expectSchema(name, item);
  }
};

export type JsonResponse = { status: number; headers: Record<string, string>; text: string; json: any };

export type RequestInit = { body?: unknown; raw?: string | Uint8Array; headers?: Record<string, string>; contentType?: string | null };

const parseJsonBody = (headers: Record<string, string>, text: string): any =>
  text !== '' && /^application\/(?:[\w.+-]+\+)?json\b/.test(headers['content-type'] ?? '') ? JSON.parse(text) : undefined;

export const sendJson = async (client: UdsClient, method: string, target: string, init: RequestInit = {}): Promise<JsonResponse> => {
  const headers: Record<string, string> = { ...init.headers };
  let body: string | Uint8Array | undefined;
  if (init.raw !== undefined) body = init.raw;
  else if (init.body !== undefined) body = JSON.stringify(init.body);
  if (body !== undefined && init.contentType !== null) headers['content-type'] = init.contentType ?? 'application/json';
  const response = await client.request({ method, path: target, headers, ...(body === undefined ? {} : { body }) });
  const text = await response.text();
  const json = parseJsonBody(response.headers, text);
  validateJsonBody(response.status, json);
  return { status: response.status, headers: response.headers, text, json };
};

export const expectError = (response: JsonResponse, status: number, code?: string): void => {
  expect({ status: response.status, body: response.json }).toMatchObject({ status, ...(code === undefined ? {} : { body: { error: { code } } }) });
};

export type SseFrame = { id?: string; event?: string; data?: string; comment?: string };

export async function* parseSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replaceAll('\r\n', '\n');
    for (let boundary = buffer.indexOf('\n\n'); boundary !== -1; boundary = buffer.indexOf('\n\n')) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const frame = parseBlock(block);
      if (frame !== undefined) yield frame;
    }
  }
}

const parseBlock = (block: string): SseFrame | undefined => {
  const frame: SseFrame = {};
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line === '') continue;
    if (line.startsWith(':')) {
      frame.comment = line.slice(1).replace(/^ /, '');
      continue;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'id') frame.id = value;
    else if (field === 'event') frame.event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length > 0) frame.data = data.join('\n');
  return Object.keys(frame).length === 0 ? undefined : frame;
};

export type StreamEvent = Record<string, any> & { id: number; type: string; sessionId: string; createdAt: number };

export type EventStream = {
  status: number;
  headers: Record<string, string>;
  events: StreamEvent[];
  comments: string[];
  ended: boolean;
  next(ms?: number): Promise<StreamEvent | undefined>;
  nextComment(ms?: number): Promise<string>;
  until(predicate: (event: StreamEvent) => boolean, ms?: number): Promise<StreamEvent[]>;
  toEnd(ms?: number): Promise<StreamEvent[]>;
  close(): void;
};

export type StreamCursor = 'seq' | 'id';

export const openEventStream = async (
  client: UdsClient,
  target: string,
  options: { headers?: Record<string, string>; idField?: StreamCursor } = {},
): Promise<EventStream> => {
  const controller = new AbortController();
  const response = await client.request({ method: 'GET', path: target, headers: { accept: 'text/event-stream', ...options.headers }, signal: controller.signal });
  const idField = options.idField ?? 'seq';
  const queue: (SseFrame | 'end' | Error)[] = [];
  let notify: (() => void) | undefined;
  const push = (item: SseFrame | 'end' | Error): void => {
    queue.push(item);
    notify?.();
  };
  const stream: EventStream = {
    status: response.status,
    headers: response.headers,
    events: [],
    comments: [],
    ended: false,
    next: async (ms = 5000) => {
      for (;;) {
        const item = await take(ms);
        if (item === 'end') return undefined;
        if (item.comment !== undefined && item.data === undefined) {
          stream.comments.push(item.comment);
          continue;
        }
        return accept(item);
      }
    },
    nextComment: async (ms = 5000) => {
      for (;;) {
        const item = await take(ms);
        if (item === 'end') throw new Error('stream ended before a comment frame');
        if (item.comment !== undefined && item.data === undefined) {
          stream.comments.push(item.comment);
          return item.comment;
        }
        accept(item);
      }
    },
    until: async (predicate, ms = 5000) => {
      const seen: StreamEvent[] = [];
      for (;;) {
        const event = await stream.next(ms);
        if (event === undefined) throw new Error(`stream ended before the expected event; saw ${seen.map((item) => item.type).join(', ')}`);
        seen.push(event);
        if (predicate(event)) return seen;
      }
    },
    toEnd: async (ms = 5000) => {
      const seen: StreamEvent[] = [];
      for (;;) {
        const event = await stream.next(ms);
        if (event === undefined) return seen;
        seen.push(event);
      }
    },
    close: () => controller.abort(),
  };
  const accept = (frame: SseFrame): StreamEvent => {
    if (frame.data === undefined) throw new Error(`SSE frame without data: ${JSON.stringify(frame)}`);
    const event = JSON.parse(frame.data) as StreamEvent;
    expectSchema('PublicRunEvent', event);
    expect(frame.event).toBe(event.type);
    expect(frame.id).toBe(String(event[idField]));
    stream.events.push(event);
    return event;
  };
  const take = async (ms: number): Promise<SseFrame | 'end'> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const item = queue.shift();
      if (item instanceof Error) throw item;
      if (item !== undefined) return item;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out after ${ms} ms waiting for an SSE frame`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        notify = () => {
          clearTimeout(timer);
          notify = undefined;
          resolve();
        };
      });
    }
  };
  onCleanup(() => controller.abort());
  if (response.status !== 200) {
    const json = parseJsonBody(response.headers, await response.text());
    validateJsonBody(response.status, json);
    (stream as EventStream & { json: unknown }).json = json;
    stream.ended = true;
    push('end');
    return stream;
  }
  void (async () => {
    try {
      for await (const frame of parseSse(response.body)) push(frame);
      stream.ended = true;
      push('end');
    } catch (error) {
      stream.ended = true;
      if (controller.signal.aborted) push('end');
      else push(error instanceof Error ? error : new Error(String(error)));
    }
  })();
  return stream;
};

export const waitUntil = async (condition: () => boolean, ms: number, label: string): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
};

export type ServiceOverrides = {
  timers?: FakeTimers;
  keepAliveMs?: number;
  sweepIntervalMs?: number;
  dataVersionPollMs?: number;
  maxBodyBytes?: number;
  maxAttempts?: number;
  clock?: FakeClock;
  wrapStore?: (store: RuntimeStore) => RuntimeStore;
  cancelUpstream?: (runId: string) => Promise<void>;
};

export type Notifier = { onCommit(touched: { runId?: string; sessionId: string }[]): void; subscriberCount(): number };

export type RunService = { socketPath: string; close(): Promise<void> };

export type ServiceEnv = Awaited<ReturnType<typeof startService>>;

export const createNotifier = (): Notifier => {
  const factory = (runtime as Record<string, unknown>)['createRunNotifier'];
  if (typeof factory !== 'function') throw new Error('@momonga/runtime does not export createRunNotifier');
  return factory() as Notifier;
};

export const openStore = (dbPath: string, clock: FakeClock, extra: { notifier?: Notifier; maxAttempts?: number } = {}): RuntimeStore => {
  const store = openRuntimeStore({
    path: dbPath,
    home: path.dirname(dbPath),
    clock,
    leaseMs: LEASE_MS,
    maxAttempts: extra.maxAttempts ?? 5,
    maxTotalAttempts: 50,
    ...(extra.notifier === undefined ? {} : { onCommit: (touched: { runId?: string; sessionId: string }[]) => extra.notifier?.onCommit(touched) }),
  } as Parameters<typeof openRuntimeStore>[0]);
  onCleanup(() => store.close());
  return store;
};

export const serviceOptions = (
  base: { store: RuntimeStore; clock: FakeClock; home: string; socketPath: string; ports: FakePorts; notifier: Notifier; errors: unknown[] },
  overrides: ServiceOverrides = {},
): Record<string, unknown> => ({
  store: base.store,
  clock: base.clock,
  home: base.home,
  version: SERVICE_VERSION,
  socketPath: base.socketPath,
  credentialEnvNames: base.ports.credentialEnvNames,
  modelAliases: base.ports.modelAliases,
  settingsFor: base.ports.settingsFor,
  defaults: { modelAlias: MODEL_ALIAS, runTimeoutMs: DEFAULT_TIMEOUT_MS, limits: { ...DEFAULT_LIMITS } },
  notifier: base.notifier,
  keepAliveMs: overrides.keepAliveMs ?? 600_000,
  sweepIntervalMs: overrides.sweepIntervalMs ?? 600_000,
  dataVersionPollMs: overrides.dataVersionPollMs ?? (overrides.timers === undefined ? 20 : 1000),
  ...(overrides.maxBodyBytes === undefined ? {} : { maxBodyBytes: overrides.maxBodyBytes }),
  ...(overrides.timers === undefined ? {} : { timers: overrides.timers }),
  ...(overrides.cancelUpstream === undefined ? {} : { cancelUpstream: overrides.cancelUpstream }),
  onError: (error: unknown) => base.errors.push(error),
});

export const launchService = async (options: Record<string, unknown>): Promise<RunService> => {
  const factory = (runtime as Record<string, unknown>)['createRunService'];
  if (typeof factory !== 'function') throw new Error('@momonga/runtime does not export createRunService');
  return (await factory(options)) as RunService;
};

export const startService = async (overrides: ServiceOverrides & { fakeTimers?: boolean } = {}) => {
  const layout = makeLayout();
  const clock = overrides.clock ?? createFakeClock(START_MS);
  const timers = overrides.timers ?? (overrides.fakeTimers === true ? createFakeTimers(clock) : undefined);
  const notifier = createNotifier();
  const store = openStore(layout.dbPath, clock, { notifier, ...(overrides.maxAttempts === undefined ? {} : { maxAttempts: overrides.maxAttempts }) });
  const ports = createFakePorts();
  const errors: unknown[] = [];
  const service = await launchService(
    serviceOptions({ store: overrides.wrapStore === undefined ? store : overrides.wrapStore(store), clock, home: layout.home, socketPath: layout.socketPath, ports, notifier, errors }, { ...overrides, ...(timers === undefined ? {} : { timers }) }),
  );
  let closed = false;
  const closeService = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await service.close();
  };
  onCleanup(closeService);
  const client = createUdsClient(layout.socketPath);
  onCleanup(() => client.close());
  let rawDb: DatabaseSync | undefined;
  onCleanup(() => rawDb?.close());

  const raw = (): DatabaseSync => {
    if (rawDb === undefined) {
      rawDb = new DatabaseSync(layout.dbPath);
      rawDb.exec('PRAGMA busy_timeout = 5000');
    }
    return rawDb;
  };

  const http = (method: string, target: string, init?: RequestInit): Promise<JsonResponse> => sendJson(client, method, target, init);

  const createSession = async (body: Record<string, unknown> = {}): Promise<any> => {
    const response = await http('POST', '/v1/sessions', { body: { cwd: layout.project, env: { PATH: '/usr/bin:/bin', LANG: 'C' }, ...body } });
    if (response.status !== 201) throw new Error(`session creation failed with ${response.status}: ${response.text}`);
    return response.json.session;
  };

  const createRun = async (sessionId: string, body: Record<string, unknown> = {}, headers?: Record<string, string>): Promise<any> => {
    const response = await http('POST', `/v1/sessions/${sessionId}/runs`, { body: { input: 'Say hello', ...body }, ...(headers === undefined ? {} : { headers }) });
    if (response.status !== 202) throw new Error(`run creation failed with ${response.status}: ${response.text}`);
    return response.json.run;
  };

  const getRun = async (runId: string): Promise<any> => {
    const response = await http('GET', `/v1/runs/${runId}`);
    if (response.status !== 200) throw new Error(`run read failed with ${response.status}: ${response.text}`);
    return response.json.run;
  };

  const claimRun = (runId: string, workerId = 'test-worker'): Claim => {
    const claim = store.claim(workerId);
    if (claim === null || claim.runId !== runId) throw new Error(`could not claim run ${runId}`);
    return claim;
  };

  const append = (claim: Claim, payloads: readonly RunEventPayload[]): void => {
    const result = store.append(claim, payloads);
    if (result.kind !== 'ok') throw new Error(`append failed: ${result.kind}`);
  };

  const notices = (count: number, prefix = 'n'): RunEventPayload[] =>
    Array.from({ length: count }, (_, index) => ({ type: 'notice', level: 'info', message: `${prefix}${index + 1}` }));

  const runEvents = (runId: string): RunEvent[] => store.readRunEvents(runId, 0, 100_000);

  const ofType = <T extends RunEvent['type']>(runId: string, type: T): Extract<RunEvent, { type: T }>[] =>
    runEvents(runId).filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);

  const stream = (target: string, options?: { headers?: Record<string, string>; idField?: StreamCursor }): Promise<EventStream> =>
    openEventStream(client, target, options);

  return {
    layout,
    clock,
    timers,
    notifier,
    store,
    ports,
    errors,
    service,
    client,
    closeService,
    raw,
    http,
    createSession,
    createRun,
    getRun,
    claimRun,
    append,
    notices,
    runEvents,
    ofType,
    stream,
  };
};

export const OPTIONS: PermissionOption[] = [
  { optionId: 'opt-allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'opt-reject-once', name: 'Reject once', kind: 'reject_once' },
];

export const SUBJECT_DIGEST = 'a'.repeat(64);

export const toolCallPayload = (callId: string, target: string): RunEventPayload => ({
  type: 'tool.call',
  callId,
  providerCallId: `fc_${callId}`,
  name: 'Write',
  kind: 'edit',
  title: `Write ${target}`,
  rawInput: { file_path: target, content: 'x' },
  locations: [{ path: target }],
});

export const requestManualApproval = (
  env: ServiceEnv,
  claim: Claim,
  callId: string,
  expiresAt: number,
  extra: { suggestedRule?: string } = {},
): string => {
  const result = env.store.requestApproval(claim, {
    callId,
    options: OPTIONS,
    expiresAt,
    event: { subjectDigest: SUBJECT_DIGEST, ...extra },
  });
  if (result.kind !== 'ok') throw new Error(`requestApproval failed: ${result.kind}`);
  return result.approval.id;
};

export type WorkerKit = {
  gateway: FakeGateway;
  settings: FakeSettings;
  toolbox: FakeToolbox;
  fatals: Error[];
  worker(id?: string, overrides?: Partial<WorkerOptions>): Worker;
  runOnce(worker: Worker): Promise<'idle' | 'yielded'>;
};

export const attachWorkerKit = (env: ServiceEnv): WorkerKit => {
  const markers = path.join(env.layout.root, 'm');
  fs.mkdirSync(markers, { recursive: true, mode: 0o700 });
  const gateway = createFakeGateway(capabilitiesFor(100_000));
  const settings = createFakeSettings({ home: env.layout.home, project: env.layout.projectReal });
  const tracer = createFakeTracer();
  const toolbox = createFakeToolbox();
  const instructions = createFakeInstructions();
  const executor = createToolExecutor({ idempotency: env.store.idempotency, blobs: env.store.blobs, clock: env.clock, processMarkerDir: markers, onWarning: () => undefined });
  const sessionsTmpRoot = path.join(env.layout.root, 'sessions');
  const sessionTmpDir = path.join(sessionsTmpRoot, 'session-tmp');
  fs.mkdirSync(sessionTmpDir, { recursive: true, mode: 0o700 });
  const sandboxPolicy: SandboxPolicy = {
    writableRoots: [env.layout.projectReal],
    writeDenied: [sessionsTmpRoot],
    readDenied: [sessionsTmpRoot],
    readAllowed: [sessionTmpDir],
    network: 'deny',
  };
  const sessionStates = new Map<string, ToolSessionState>();
  const workers: Worker[] = [];
  const fatals: Error[] = [];
  const pendingRuns: Promise<unknown>[] = [];
  onCleanup(async () => {
    gateway.releaseAll();
    await within(Promise.allSettled(pendingRuns), 10_000, 'worker runs to settle');
    await within(Promise.allSettled(workers.map((worker) => worker.stop())), 10_000, 'workers to stop');
  });
  const snapshotToolbox = async () => {
    const registry = createToolRegistry();
    for (const tool of toolbox.tools()) registry.register(tool);
    return registry.snapshot();
  };
  const tools: ToolRuntimePort = {
    envFor: (target: Session) => ({ ...target.env }),
    toolSet: async () => snapshotToolbox(),
    recoveryToolSet: async () => snapshotToolbox(),
    executor,
    sandbox: fakeSandbox,
    policyFor: async (target: Session, policyOptions: { env: Readonly<Record<string, string>> }) => ({
      roots: [target.cwd],
      sandboxPolicy,
      protectedPaths: [],
      tmpDir: sessionTmpDir,
      env: policyOptions?.env ?? target.env,
    }),
    sessionState: (target: Session) => {
      const existing = sessionStates.get(target.id);
      if (existing !== undefined) return existing;
      const created: ToolSessionState = { cwd: target.cwd, readLedger: new Map() };
      sessionStates.set(target.id, created);
      return created;
    },
  };
  const worker = (id = 'worker-1', overrides: Partial<WorkerOptions> = {}): Worker => {
    const created = runtime.createWorker({
      store: env.store,
      gateway,
      settings,
      tools,
      tracer,
      clock: env.clock,
      workerId: id,
      leaseMs: LEASE_MS,
      systemPrompt: testSystemPrompt,
      home: env.layout.home,
      blobs: env.store.blobs,
      instructionReader: instructions,
      onFatal: (error: Error) => {
        fatals.push(error);
      },
      ...overrides,
    });
    workers.push(created);
    return created;
  };
  const runOnce = (target: Worker): Promise<'idle' | 'yielded'> => {
    const running = target.runOnce();
    pendingRuns.push(running);
    return running;
  };
  return { gateway, settings, toolbox, fatals, worker, runOnce };
};
