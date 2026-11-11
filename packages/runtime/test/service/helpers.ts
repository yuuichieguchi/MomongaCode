import { createFakeRuleVerifier } from '../worker/fake-rule-verifier.ts';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, expect } from 'vitest';
import { createRedactor, createUdsClient, EMPTY_FILE_RULES, EMPTY_PROTECTED_SET, fixedRolePort, fixedSocket, HOST_RULE_ENFORCEMENT, momongaLayout, momongaPaths, nodeFileSystem, systemRandom, BUSY_WAIT_LIMIT_MS } from '@momonga/foundation';
import type { RolePort, UdsClient } from '@momonga/foundation';
import type { PermissionRule } from '@momonga/config';
import { computeFileRules } from '@momonga/policy';
import * as protocol from '@momonga/protocol';
import type { ModelViews, PermissionMode, PermissionOption, RunEvent, RunEventPayload } from '@momonga/protocol';
import * as runtime from '@momonga/runtime';
import type { EvidenceRun, ToolRuntimePort, Worker, WorkerOptions } from '@momonga/runtime';
import type { SandboxPolicy } from '@momonga/sandbox';
import { openRuntimeStore } from '@momonga/store';
import { journalReaderPreparer } from '../worker/harness.ts';
import type { Claim, ContributionPreparer, RuntimeStore, Session } from '@momonga/store';
import { unconfiguredNetworkOf, FAKE_LEASE, fakePolicyFilesystem, hostFilesystemOf, createFakeClock, createFakeKernelLock, createFakeTimers, createTempDir, pollUntil, removeTempDir, testProbes, testProcessInspector, testKernelLock } from '@momonga/testkit';
import type { FakeClock, FakeTimers } from '@momonga/testkit';
import { createGitWorkTreeObserver, createHostRipgrepLocator, createToolExecutor, createToolRegistry, nodeShellHost } from '@momonga/tools';
import { pinnedRipgrepPath } from '../../../../test/support/pinned-ripgrep.ts';
import type { AnyTool, ToolSessionState } from '@momonga/tools';
import { createFakeGateway } from '../worker/fake-gateway.ts';
import type { FakeGateway } from '../worker/fake-gateway.ts';
import { createFakeSettings } from '../worker/fake-settings.ts';
import type { FakeSettings } from '../worker/fake-settings.ts';
import { createFakeToolbox } from '../worker/fake-tools.ts';
import type { FakeToolbox } from '../worker/fake-tools.ts';
import { createFakeTracer } from '../worker/fake-tracer.ts';
import { capabilitiesFor, createFakeInstructions, diskAgentCatalog, diskSkillsPort, fakeSandbox, inertGovernancePort, inertHistoryPort, testSystemPrompt, unavailableEvidenceRun } from '../worker/harness.ts';
import { fixedSandboxBindings, fixedTracers } from '@momonga/runtime';
import { UNASKED_COMMANDS } from '../../../store/test/support/unasked.ts';

export const START_MS = 1_800_000_000_000;
export const LEASE_MS = 30_000;
export const SERVICE_VERSION = '0.0.0-test';
export const MODEL_ID = 'fm';
export const OTHER_MODEL_ID = 'fm-large';
export const FAKE_PROVIDER = 'fake';
export const DECLARED_CREDENTIAL = 'FM_UPSTREAM_VALUE';
export const HOUR_MS = 3_600_000;
export const DEFAULT_TIMEOUT_MS = 6 * HOUR_MS;
export const DEFAULT_TTL_MS = 30 * 60 * 1000;
export const FORMER_APPROVAL_LIMIT_MS = DEFAULT_TTL_MS;
export const DEFAULT_LIMITS = { maxSteps: 50, maxTotalTokens: 1_000_000, approvalTtlMs: DEFAULT_TTL_MS, loopThreshold: 3 };
export const SOCKET_PATH_LIMIT = 104;
export const SERVICE_PID = 424_242;
export const STARTED_AT = new Date(START_MS).toISOString();

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
  const root = createTempDir();
  onCleanup(() => removeTempDir(root));
  const home = createTempDir({ asHome: true });
  onCleanup(() => removeTempDir(home));
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

export type SettingsDefault = {
  defaultMode?: PermissionMode;
  defaultModeOrigin?: 'user' | 'project' | 'local';
  additionalDirectories?: readonly string[];
  credentialEnvNames?: readonly string[];
  autoModeClassifier?: string;
};

export type SessionCreateSettingsResult = {
  defaultMode?: PermissionMode;
  defaultModeOrigin?: 'user' | 'project' | 'local';
  additionalDirectories: readonly string[];
  credentialEnvNames: readonly string[];
  autoModeClassifier?: string;
  autoModeKey?: { classifier: string; codeDigest: string; datasetDigest: string };
};

export type FakePorts = {
  settingsByCwd: Map<string, SettingsDefault>;
  settingsCalls: string[];
  settingsFailure: { error?: unknown };
  listingFailure: { error?: unknown };
  listed: string[];
  shown: { views?: ModelViews };
  start: { model: string | null | undefined };
  modelListing: () => Promise<{ views: ModelViews; start: string | null }>;
  sessionCreateSettings: (cwd: string) => Promise<SessionCreateSettingsResult>;
  sessionReadSettings: (cwd: string) => Promise<SessionCreateSettingsResult>;
};

export const createFakePorts = (): FakePorts => {
  const settingsByCwd = new Map<string, SettingsDefault>();
  const settingsCalls: string[] = [];
  const settingsFailure: { error?: unknown } = {};
  const listingFailure: { error?: unknown } = {};
  const listed: string[] = [MODEL_ID, OTHER_MODEL_ID];
  const start: { model: string | null | undefined } = { model: undefined };
  const shown: { views?: ModelViews } = {};
  const settingsOf = (cwd: string): SessionCreateSettingsResult => {
    const real = fs.existsSync(cwd) ? fs.realpathSync(cwd) : cwd;
    const entry = settingsByCwd.get(real) ?? {};
    return {
      ...(entry.defaultMode === undefined ? {} : { defaultMode: entry.defaultMode }),
      ...(entry.defaultModeOrigin === undefined ? {} : { defaultModeOrigin: entry.defaultModeOrigin }),
      additionalDirectories: entry.additionalDirectories ?? [],
      credentialEnvNames: entry.credentialEnvNames ?? [DECLARED_CREDENTIAL],
      ...(entry.autoModeClassifier === undefined
        ? {}
        : { autoModeClassifier: entry.autoModeClassifier, autoModeKey: { classifier: `fake|${entry.autoModeClassifier}`, codeDigest: 'fake-code-digest', datasetDigest: 'fake-dataset-digest' } }),
    };
  };
  return {
    settingsByCwd,
    settingsCalls,
    settingsFailure,
    listingFailure,
    listed,
    shown,
    start,
    modelListing: async () => {
      if (listingFailure.error !== undefined) throw listingFailure.error;
      const views = shown.views ?? listed.map((model) => ({ canon: model, provider: FAKE_PROVIDER, ownName: model }));
      return { views, start: start.model === undefined ? (views[0]?.canon ?? null) : start.model };
    },
    sessionCreateSettings: async (cwd) => {
      settingsCalls.push(cwd);
      if (settingsFailure.error !== undefined) throw settingsFailure.error;
      return settingsOf(cwd);
    },
    sessionReadSettings: async (cwd) => {
      settingsCalls.push(cwd);
      return settingsOf(cwd);
    },
  };
};

export const protectedAreasOf = (home: string): string[] => {
  const paths = momongaPaths(home, process.platform, {});
  return [paths.root, momongaLayout(home, process.platform, process.env).keychains, paths.tmp.root];
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

const VIEW_KEYS: Record<string, string> = { session: 'SessionView', run: 'RunView', approval: 'ApprovalView', trust: 'TrustView', memory: 'MemoryView' };
const LIST_KEYS: Record<string, string> = { sessions: 'SessionView', runs: 'RunView', approvals: 'ApprovalView', memories: 'MemoryView' };

export const validateJsonBody = (status: number, body: unknown): void => {
  if (body === undefined) return;
  if (status >= 400) {
    expectSchema('ErrorBody', body);
    return;
  }
  if (typeof body !== 'object' || body === null) return;
  if ('skills' in body && 'warnings' in body) expectSchema('SkillsResponse', body);
  if ('agents' in body && 'warnings' in body) expectSchema('AgentsResponse', body);
  for (const [key, name] of Object.entries(VIEW_KEYS)) if (key in body) expectSchema(name, (body as Record<string, unknown>)[key]);
  for (const [key, name] of Object.entries(LIST_KEYS)) {
    if (!(key in body)) continue;
    const list = (body as Record<string, unknown>)[key];
    expect(Array.isArray(list)).toBe(true);
    for (const item of list as unknown[]) expectSchema(name, item);
  }
};

export type JsonResponse = { status: number; headers: Record<string, string>; text: string; json: any };

export type RequestInit = { body?: unknown; raw?: string | Uint8Array; headers?: Record<string, string>; contentType?: string | null; person?: boolean };

export const PERSON_CAPABILITY_TEST_HEADER = 'momonga-person-capability';

export const personCapabilityFileOf = (home: string): string => path.join(home, '.momonga', 'person-capability');

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
  next(): Promise<StreamEvent | undefined>;
  nextComment(): Promise<string>;
  until(predicate: (event: StreamEvent) => boolean): Promise<StreamEvent[]>;
  toEnd(): Promise<StreamEvent[]>;
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
    next: async () => {
      for (;;) {
        const item = await take();
        if (item === 'end') return undefined;
        if (item.comment !== undefined && item.data === undefined) {
          stream.comments.push(item.comment);
          continue;
        }
        return accept(item);
      }
    },
    nextComment: async () => {
      for (;;) {
        const item = await take();
        if (item === 'end') throw new Error('stream ended before a comment frame');
        if (item.comment !== undefined && item.data === undefined) {
          stream.comments.push(item.comment);
          return item.comment;
        }
        accept(item);
      }
    },
    until: async (predicate) => {
      const seen: StreamEvent[] = [];
      for (;;) {
        const event = await stream.next();
        if (event === undefined) throw new Error(`stream ended before the expected event; saw ${seen.map((item) => item.type).join(', ')}`);
        seen.push(event);
        if (predicate(event)) return seen;
      }
    },
    toEnd: async () => {
      const seen: StreamEvent[] = [];
      for (;;) {
        const event = await stream.next();
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
  const take = async (): Promise<SseFrame | 'end'> => {
    for (;;) {
      const item = queue.shift();
      if (item instanceof Error) throw item;
      if (item !== undefined) return item;
      await new Promise<void>((resolve) => {
        notify = () => {
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

export const pollFor = (condition: () => boolean, boundMs: number, description: string): Promise<void> => pollUntil(condition, { description, boundMs });

export type McpAdminPort = Parameters<typeof runtime.createRunService>[0]['mcp'];

export const unusedMcpAdmin: McpAdminPort = {
  servers: () => Promise.reject(new Error('this test configured no MCP admin')),
  startAuthorization: () => Promise.reject(new Error('this test configured no MCP admin')),
  authorization: () => {
    throw new Error('this test configured no MCP admin');
  },
  cancelAuthorization: () => {
    throw new Error('this test configured no MCP admin');
  },
  folderServers: () => Promise.reject(new Error('this test configured no MCP admin')),
  startFolderAuthorization: () => Promise.reject(new Error('this test configured no MCP admin')),
  folderAuthorization: () => {
    throw new Error('this test configured no MCP admin');
  },
  cancelFolderAuthorization: () => {
    throw new Error('this test configured no MCP admin');
  },
};

const unusedUserInput: runtime.UserInputPort = {
  attach: () => Promise.reject(new Error('this test configured no user input port')),
  shell: () => Promise.reject(new Error('this test configured no user input port')),
};

export type ServiceOverrides = {
  permissionRules?: (session: Session) => Promise<readonly PermissionRule[]>;
  role?: RolePort;
  work?: { steps(): number; jobs(): number };
  ignorableMarkerDirectories?: (signal: AbortSignal) => Promise<readonly string[]>;
  onRequestEnd?: () => void;
  timers?: FakeTimers;
  keepAliveMs?: number;
  sweepIntervalMs?: number;
  dataVersionPollMs?: number;
  maxBodyBytes?: number;
  maxAttempts?: number;
  preparer?: (dbPath: string, store: () => RuntimeStore) => ContributionPreparer;
  onDecode?: (rows: number, bytes: number) => void;
  clock?: FakeClock;
  wrapStore?: (store: RuntimeStore) => RuntimeStore;
  cancelUpstream?: (runId: string) => Promise<void>;
  releaseStopped?: (runId: string, signal: AbortSignal) => Promise<void>;
  runTrace?: (runId: string, signal: AbortSignal) => Promise<unknown>;
  imageInput?: boolean;
  beforeCapabilities?: () => Promise<void>;
  capabilitiesOf?: (model: string) => Promise<unknown>;
  runCost?: (runs: readonly { runId: string; sessionId: string }[], signal: AbortSignal, includeRunless: boolean) => Promise<unknown>;
  reportCost?: (runIds: readonly string[], signal: AbortSignal) => Promise<unknown>;
  recomputeFacts?: (runIds: readonly string[], signal: AbortSignal) => Promise<unknown>;
  runTraceContent?: (runId: string, after: number, limit: number) => Promise<unknown>;
  onFatal?: boolean;
  sandboxKind?: 'seatbelt' | 'none';
  protectedRootAreas?: readonly string[];
  skills?: runtime.SkillsPort;
  agents?: runtime.AgentCatalogPort;
  skillsTrusted?: () => boolean;
  mcp?: McpAdminPort;
  userInput?: runtime.UserInputPort;
  evidenceRun?: (project: string) => EvidenceRun;
  delegation?: DelegationPort;
  modelListing?: (signal: AbortSignal) => Promise<{ views: ModelViews; start: string | null }>;
};

export type DelegationPort = NonNullable<Parameters<typeof runtime.createRunService>[0]['delegation']>;

export type Notifier = { onCommit(touched: { runId?: string; sessionId: string }[]): void; subscriberCount(): number };

export type RunService = {
  socketPath: string;
  beginDraining(): void;
  applyRole(): void;
  openRequests(): number;
  stopListening(): void;
  retire(current: { generation: number; version: string } | undefined): Promise<void>;
  close(): Promise<void>;
};

export type ServiceEnv = Awaited<ReturnType<typeof startService>>;

export const createNotifier = (): Notifier => {
  const factory = (runtime as Record<string, unknown>)['createRunNotifier'];
  if (typeof factory !== 'function') throw new Error('@momonga/runtime does not export createRunNotifier');
  return factory() as Notifier;
};

export const openStore = (
  dbPath: string,
  clock: FakeClock,
  extra: { notifier?: Notifier; maxAttempts?: number; preparer?: (dbPath: string, store: () => RuntimeStore) => ContributionPreparer; onDecode?: (rows: number, bytes: number) => void } = {},
): RuntimeStore => {
  const store: RuntimeStore = openRuntimeStore({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), fileSystem: nodeFileSystem, random: systemRandom, unaskedCommands: UNASKED_COMMANDS,
    path: dbPath,
    home: path.dirname(dbPath),
    clock,
    leaseMs: LEASE_MS,
    maxAttempts: extra.maxAttempts ?? 5,
    maxTotalAttempts: 50,
    preparer: extra.preparer === undefined ? journalReaderPreparer(dbPath) : extra.preparer(dbPath, () => store),
    ...(extra.onDecode === undefined ? {} : { onDecode: extra.onDecode }),
    ...(extra.notifier === undefined ? {} : { onCommit: (touched: { runId?: string; sessionId: string }[]) => extra.notifier?.onCommit(touched) }),
  } as Parameters<typeof openRuntimeStore>[0]);
  onCleanup(() => store.close());
  return store;
};

export const defaultModelCapabilities = (imageInput = false) => ({
  contextWindow: 8192,
  maxOutputTokens: 2048,
  toolCalling: 'native',
  structuredOutput: 'none',
  streaming: true,
  stopSequences: true,
  ...protocol.imageCapability(imageInput, imageInput ? { pixelsPerToken: 750, maxTokens: 1600, minTokens: 1 } : undefined),
  parallelToolCalls: false,
  schemaDialect: 'json-schema-2020-12',
  tokenCounting: 'estimated',
  usageReported: true,
  maxConcurrency: 1,
  source: 'declared',
});

export const serviceOptions = (
  base: { store: RuntimeStore; clock: FakeClock; home: string; socketPath: string; ports: FakePorts; notifier: Notifier; errors: unknown[]; fatals?: Error[] },
  overrides: ServiceOverrides = {},
): Record<string, unknown> => ({
  store: base.store,
  clock: base.clock,
  redactor: createRedactor({ credentials: [] }),
  home: base.home,
  lock: testKernelLock(),
  version: SERVICE_VERSION,
  socketPath: base.socketPath,
  pid: SERVICE_PID,
  startedAt: STARTED_AT,
  sandboxKind: async () => overrides.sandboxKind ?? 'seatbelt',
  protectedRootAreas: overrides.protectedRootAreas ?? protectedAreasOf(base.home),
  modelListing: overrides.modelListing ?? base.ports.modelListing,
  modelCapabilities: async (model: string) => {
    await overrides.beforeCapabilities?.();
    if (overrides.capabilitiesOf !== undefined) return overrides.capabilitiesOf(model);
    return defaultModelCapabilities(overrides.imageInput === true);
  },
  sessionCreateSettings: base.ports.sessionCreateSettings,
  sessionReadSettings: base.ports.sessionReadSettings,
  skills: overrides.skills ?? diskSkillsPort(base.home, overrides.skillsTrusted),
  agents: overrides.agents ?? diskAgentCatalog(base.home, overrides.skillsTrusted),
  permissionRules: overrides.permissionRules ?? (async () => []),
  evidenceRun: overrides.evidenceRun ?? unavailableEvidenceRun,
  mcp: overrides.mcp ?? unusedMcpAdmin,
  userInput: overrides.userInput ?? unusedUserInput,
  defaults: { model: MODEL_ID, runTimeoutMs: DEFAULT_TIMEOUT_MS, limits: { ...DEFAULT_LIMITS } },
  notifier: base.notifier,
  keepAliveMs: overrides.keepAliveMs ?? 600_000,
  sweepIntervalMs: overrides.sweepIntervalMs ?? 600_000,
  dataVersionPollMs: overrides.dataVersionPollMs ?? (overrides.timers === undefined ? 20 : 1000),
  ...(overrides.maxBodyBytes === undefined ? {} : { maxBodyBytes: overrides.maxBodyBytes }),
  ...(overrides.timers === undefined ? {} : { timers: overrides.timers }),
  ...(overrides.cancelUpstream === undefined ? {} : { cancelUpstream: overrides.cancelUpstream }),
  releaseStopped: overrides.releaseStopped ?? (async () => undefined),
  runTrace: overrides.runTrace ?? (async () => undefined),
  reportCost: overrides.reportCost ?? (async () => []),
  recomputeFacts: overrides.recomputeFacts ?? (async () => ({ rows: [], refused: [] })),
  runTraceContent: overrides.runTraceContent ?? (async () => ({ bodies: [], next: null })),
  runCost:
    overrides.runCost ??
    (async () => ({
      report: {
        runs: [],
        sessions: [],
        total: { calls: 0, localCalls: 0, unpricedCalls: 0, unknownBillingCalls: 0, planCalls: 0, planInputTokens: 0, planOutputTokens: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, amount: 0, currency: 'USD', priceVersions: [] },
      },
      text: 'cost report',
    })),
  role: overrides.role ?? fixedRolePort('serving'),
  work: overrides.work ?? { steps: () => 0, jobs: () => 0 },
  ignorableMarkerDirectories: overrides.ignorableMarkerDirectories ?? (async () => [momongaLayout(base.home, process.platform, process.env).markers.root]),
  files: nodeFileSystem,
  ...(overrides.onRequestEnd === undefined ? {} : { onRequestEnd: overrides.onRequestEnd }),
  ...(overrides.delegation === undefined ? {} : { delegation: overrides.delegation }),
  onError: (error: unknown) => base.errors.push(error),
  ...(base.fatals === undefined ? {} : { onFatal: (error: Error) => base.fatals?.push(error) }),
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
  const store = openStore(layout.dbPath, clock, {
    notifier,
    ...(overrides.maxAttempts === undefined ? {} : { maxAttempts: overrides.maxAttempts }),
    ...(overrides.preparer === undefined ? {} : { preparer: overrides.preparer }),
    ...(overrides.onDecode === undefined ? {} : { onDecode: overrides.onDecode }),
  });
  const ports = createFakePorts();
  const errors: unknown[] = [];
  const fatals: Error[] = [];
  const service = await launchService(
    serviceOptions(
      {
        store: overrides.wrapStore === undefined ? store : overrides.wrapStore(store),
        clock,
        home: layout.home,
        socketPath: layout.socketPath,
        ports,
        notifier,
        errors,
        ...(overrides.onFatal === true ? { fatals } : {}),
      },
      { ...overrides, ...(timers === undefined ? {} : { timers }) },
    ),
  );
  let closed = false;
  const closeService = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await service.close();
  };
  onCleanup(closeService);
  const client = createUdsClient(fixedSocket(layout.socketPath), { connectTimeoutMs: 0 });
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

  const http = (method: string, target: string, init: RequestInit = {}): Promise<JsonResponse> =>
    sendJson(client, method, target, init.person === false ? init : { ...init, headers: { [PERSON_CAPABILITY_TEST_HEADER]: fs.readFileSync(personCapabilityFileOf(layout.home), 'utf8'), ...init.headers } });

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
    fatals,
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

export const requestManualApproval = async (
  env: ServiceEnv,
  claim: Claim,
  callId: string,
  extra: { suggestedRule?: string } = {},
): Promise<string> => {
  const result = await env.store.requestApproval(claim, {
    callId,
    options: OPTIONS,
    event: { subjectDigest: SUBJECT_DIGEST, reason: 'edits require approval', ...extra, shown: { title: 'approval', input: {} } },
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
  const callLocks = path.join(env.layout.root, 'call-locks');
  fs.mkdirSync(callLocks, { recursive: true, mode: 0o700 });
  const gateway = createFakeGateway(capabilitiesFor(100_000));
  const settings = createFakeSettings({ home: env.layout.home, project: env.layout.projectReal });
  const tracer = createFakeTracer();
  const toolbox = createFakeToolbox();
  const instructions = createFakeInstructions();
  const executor = createToolExecutor({
    layout: momongaLayout(env.layout.home, process.platform, process.env),
    reap: { inspector: testProcessInspector() },
    shellHost: nodeShellHost(),
    random: systemRandom,
    files: nodeFileSystem, outboundNetwork: unconfiguredNetworkOf, fs: hostFilesystemOf(fakePolicyFilesystem()), ...FAKE_LEASE, idempotency: env.store.idempotency, blobs: env.store.blobs, clock: env.clock, processMarkerDir: markers, callLockDir: callLocks, kernelLock: createFakeKernelLock({ inheritable: false }), onWarning: () => undefined });
  const sessionsTmpRoot = path.join(env.layout.root, 'sessions');
  const sessionTmpDir = path.join(sessionsTmpRoot, 'session-tmp');
  fs.mkdirSync(sessionTmpDir, { recursive: true, mode: 0o700 });
  const sandboxPolicy: SandboxPolicy = {
    writableRoots: [env.layout.projectReal],
    writeDenied: [sessionsTmpRoot], protectedSet: EMPTY_PROTECTED_SET, writeDeniedLiterals: [], fileRules: EMPTY_FILE_RULES,
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
    await Promise.allSettled(pendingRuns);
    await Promise.allSettled(workers.map((worker) => worker.stop()));
  });
  const snapshotToolbox = async (additionalTools: readonly AnyTool[] = [], only?: readonly string[]) => {
    const registry = createToolRegistry();
    for (const tool of [...toolbox.tools(), ...additionalTools]) registry.register(tool);
    return registry.snapshot(only === undefined ? {} : { only });
  };
  const tools: ToolRuntimePort = {
    inspector: testProcessInspector(),
    workTreeObserver: (target: Session) => createGitWorkTreeObserver({ storeDir: path.join(env.layout.root, 'observer'), workTree: target.cwd, trusted: false }),
    envFor: (target: Session) => ({ ...target.env }),
    toolSet: async (_runId: string, toolSetOptions: { additionalTools?: readonly AnyTool[]; only?: readonly string[] }) =>
      snapshotToolbox(toolSetOptions.additionalTools, toolSetOptions.only),
    recoveryToolSet: async () => snapshotToolbox(),
    executor,
    sandboxes: fixedSandboxBindings(fakeSandbox),
    ripgrepLocator: (target) => createHostRipgrepLocator({ setting: pinnedRipgrepPath(), env: target }),
    shellHost: nodeShellHost(),
    markerDir: markers,
    policyFor: async (target: Session, policyOptions: { env: Readonly<Record<string, string>>; rules: readonly PermissionRule[] }) => ({
      roots: [target.cwd],
      sandboxPolicy: { ...sandboxPolicy, fileRules: await computeFileRules(policyOptions.rules, [target.cwd], sessionTmpDir, HOST_RULE_ENFORCEMENT, testProbes()) },
      tmpDir: sessionTmpDir,
      env: policyOptions?.env ?? target.env,
    }),
    recoveryContextFor: async (target: Session, recoveryOptions: { env: Readonly<Record<string, string>> }) => ({ roots: [target.cwd], tmpDir: sessionTmpDir, env: recoveryOptions.env }),
    sessionState: (target: Session) => {
      const existing = sessionStates.get(target.id);
      if (existing !== undefined) return existing;
      const created: ToolSessionState = { cwd: target.cwd, workingDirectory: target.cwd, readLedger: new Map() };
      sessionStates.set(target.id, created);
      return created;
    },
  };
  const worker = (id = 'worker-1', overrides: Partial<WorkerOptions> = {}): Worker => {
    const created = runtime.createWorker({
      store: env.store,
      gateway,
      settings,
      skills: diskSkillsPort(env.layout.home),
      memories: runtime.createMemoryPort({ platform: process.platform, store: env.store, settings, evidenceRun: unavailableEvidenceRun }),
      history: inertHistoryPort,
      governance: inertGovernancePort,
      tools,
      ruleVerifier: createFakeRuleVerifier(),
      tracers: fixedTracers(tracer),
      clock: env.clock,
      workerId: id,
      role: fixedRolePort('serving'),
      leaseMs: LEASE_MS,
      random: () => 0.5,
      platform: 'darwin',
      timers: { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout) },
      systemPrompt: testSystemPrompt,
      home: env.layout.home,
      blobs: env.store.blobs,
      instructionReaderFor: () => instructions,
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
