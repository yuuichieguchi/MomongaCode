import { spawn } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcessByStdio } from '@momonga/testkit/child-process';
import type { Readable, Writable } from 'node:stream';
import { expect } from 'vitest';
import type { SandboxSetting } from '@momonga/config';
import { MINIMAL_CHILD_PATH, createUdsClient, fixedSocket, parseReadyLine } from '@momonga/foundation';
import type { ReadyFields } from '@momonga/foundation';
import type { SupervisorChildState, SupervisorHealth, SupervisorPhase, TargetAnswers } from '@momonga/protocol';
import { startGenerationForTest } from '@momonga/testkit/first-generation';
import cliPackage from '../../packages/cli/package.json' with { type: 'json' };
import { superviseInvocation } from '../../packages/cli/src/daemon/launcher.ts';
import { CLI_BUNDLE } from './cli-bundles.ts';
import type { ChildRole } from '@momonga/supervisor';
import { firstGeneration, modelSettings, productTestEnv, startFakeChatCompletions } from '@momonga/testkit';
import type { FakeChatCompletionsServer, FakeRoute, FakeScriptEntry } from '@momonga/testkit';
import { SUPERVISOR_APP_VERSION } from './app-version.ts';
import { registerE2eCleanup } from './home.ts';
import type { E2eHome } from './home.ts';
import { REPO_ROOT } from './launcher.ts';
import { E2E_RUN_ENV } from './run-env.ts';
import { resolveSandbox } from './sandbox.ts';
import { trackStreamErrors } from './stream-errors.ts';
import { createSupervisorClient } from './supervisor-client.ts';
import type { SupervisorClient } from './supervisor-client.ts';
import { E2E_DEPS_ENV } from './supervisor-main.ts';
import type { E2eDeps } from './supervisor-main.ts';
import { E2E_SUPERVISOR_CLOSE_BOUND_MS, e2eStartBoundMs, until, withinBound } from './wait.ts';
import { pinnedRipgrepPath } from '../../test/support/pinned-ripgrep.ts';

export const SUPERVISOR_MAIN_PATH = path.join(REPO_ROOT, 'e2e', 'support', 'supervisor-main.ts');
export { SUPERVISOR_APP_VERSION };
export const SUPERVISOR_ENV_PATH = MINIMAL_CHILD_PATH;
export const STDERR_TAIL_BYTES = 64 * 1024;
export const UPSTREAM_MODEL = 'system';
export const UPSTREAM_PROVIDER = 'fake';
export const UPSTREAM_CONTEXT_WINDOW = 16_384;

export const RIPGREP_OF_A_JS_BUNDLE_THAT_EMBEDS_NONE = pinnedRipgrepPath;

export type StackSandbox = SandboxSetting;

export type StackReadiness = { phase: SupervisorPhase; children: Readonly<Record<ChildRole, SupervisorChildState>> };

export type StackModelCapabilities = { readonly contextWindow: number; readonly maxOutputTokens: number };

export type StackModel = { readonly capabilities?: StackModelCapabilities; readonly toolCalling?: 'native' | 'constrained'; readonly answers?: 'model' | 'script' };

export type StartStackOptions = {
  home: E2eHome;
  preparedGeneration?: number;
  needsBash?: boolean;
  sandbox?: StackSandbox;
  settings?: Readonly<Record<string, unknown>>;
  settingsText?: string;
  deps?: E2eDeps;
  script?: FakeScriptEntry[];
  routes?: FakeRoute[];
  model?: StackModel;
  upstream?: FakeChatCompletionsServer;
  upstreamImageInput?: boolean;
  readiness?: Partial<StackReadiness> | false;
  readinessDeadlineMs?: number;
  supervisorScript?: string;
  version?: string;
};

export type SupervisorExit = { code: number | null; signal: NodeJS.Signals | null };

export type SpawnedSupervisor = {
  readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
  readonly pid: number;
  readonly depsFile: string | undefined;
  ready(deadlineMs?: number): Promise<ReadyFields>;
  exitState(): SupervisorExit | undefined;
  stdoutLines(): readonly string[];
  stderrTail(): string;
  exited: Promise<SupervisorExit>;
};

export type SupervisorEntry = { readonly kind: 'product'; readonly generation: number } | { readonly kind: 'test'; readonly deps: E2eDeps; readonly script?: string; readonly version?: string; readonly generation?: number };

export type SpawnSupervisorOptions = { home: E2eHome; entry: SupervisorEntry; stackNumber?: number };

export type E2eStack = {
  readonly home: E2eHome;
  readonly fake: FakeChatCompletionsServer;
  readonly routeHits: readonly number[];
  readonly supervisor: SpawnedSupervisor;
  readonly ready: ReadyFields;
  readonly client: SupervisorClient;
  readonly sandbox: StackSandbox;
  readonly sandboxFallback?: string;
  readonly health: SupervisorHealth;
};

const SETTINGS_FILE_MODE = 0o600;
const DEPS_FILE_MODE = 0o600;
const DEFAULT_READINESS: StackReadiness = { phase: 'running', children: { gateway: 'ready', runtime: 'ready' } };
const ROLES: readonly ChildRole[] = ['gateway', 'runtime'];
const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION_BITS = 0x80;

let settingsWriteCounter = 0;

type StackModelEntry = { id: string; capabilities: Record<string, unknown>; [key: string]: unknown };

type StackConnection = { provider: string; models: StackModelEntry[]; [key: string]: unknown };

type StackModels = { connections: StackConnection[]; roles?: Record<string, unknown>; [key: string]: unknown };

export const upstreamModelRef = (id: string): string => `${UPSTREAM_PROVIDER}/${id}`;

export const UPSTREAM_MODEL_REF = upstreamModelRef(UPSTREAM_MODEL);

export const baseSettings = (home: E2eHome, sandbox: StackSandbox): Record<string, unknown> => ({
  ...modelSettings({
    start: UPSTREAM_MODEL_REF,
    models: [
      {
        provider: UPSTREAM_PROVIDER,
        adapter: 'chat-completions',
        id: UPSTREAM_MODEL,
        answers: 'script' satisfies TargetAnswers,
        socketPath: home.upstreamSocket,
        capabilities: { contextWindow: UPSTREAM_CONTEXT_WINDOW, maxOutputTokens: 1024 },
      },
    ],
  }),
  sandbox,
  tools: { ripgrep: RIPGREP_OF_A_JS_BUNDLE_THAT_EMBEDS_NONE() },
});

const modelsOf = (settings: Readonly<Record<string, unknown>>): StackModels => settings['models'] as StackModels;

export const upstreamConnectionOf = (settings: Readonly<Record<string, unknown>>): StackConnection => {
  const connection = modelsOf(settings).connections.find((candidate) => candidate.provider === UPSTREAM_PROVIDER);
  if (connection === undefined) throw new Error(`no ${UPSTREAM_PROVIDER} connection in the settings`);
  return connection;
};

export const upstreamEntryOf = (settings: Readonly<Record<string, unknown>>): StackModelEntry => {
  const entry = upstreamConnectionOf(settings).models.find((candidate) => candidate.id === UPSTREAM_MODEL);
  if (entry === undefined) throw new Error(`no ${UPSTREAM_MODEL_REF} model in the settings`);
  return entry;
};

export const withUpstreamConnection = (settings: Readonly<Record<string, unknown>>, change: (connection: StackConnection) => StackConnection): Record<string, unknown> => {
  const models = modelsOf(settings);
  const upstream = upstreamConnectionOf(settings);
  return { ...settings, models: { ...models, connections: models.connections.map((connection) => (connection === upstream ? change(connection) : connection)) } };
};

export const withUpstreamEntry = (settings: Readonly<Record<string, unknown>>, change: (entry: StackModelEntry) => StackModelEntry): Record<string, unknown> => {
  const upstream = upstreamEntryOf(settings);
  return withUpstreamConnection(settings, (connection) => ({ ...connection, models: connection.models.map((entry) => (entry === upstream ? change(entry) : entry)) }));
};

export const withStructuredModel = (settings: Readonly<Record<string, unknown>>, id: string): Record<string, unknown> => {
  const upstream = upstreamEntryOf(settings);
  const structured = { ...upstream, id, capabilities: { ...upstream.capabilities, structuredOutput: 'json_schema' } };
  return withUpstreamConnection(settings, (connection) => ({ ...connection, models: [...connection.models, structured] }));
};

export const withClassifierModel = (settings: Readonly<Record<string, unknown>>, id: string): Record<string, unknown> => ({
  ...withStructuredModel(settings, id),
  autoMode: { classifier: upstreamModelRef(id) },
});

export type StructuredRole = 'reflection' | 'analysis';

export const withStructuredRole = (settings: Readonly<Record<string, unknown>>, role: StructuredRole, id: string): Record<string, unknown> => {
  const structured = withStructuredModel(settings, id);
  const models = modelsOf(structured);
  return { ...structured, models: { ...models, roles: { ...models.roles, [role]: upstreamModelRef(id) } } };
};

export const contextWindowOf = (home: E2eHome): number => upstreamEntryOf(baseSettings(home, 'none')).capabilities['contextWindow'] as number;

export const settingsWithModel = (settings: Readonly<Record<string, unknown>>, model: StackModel): Record<string, unknown> => {
  const entryChanged = withUpstreamEntry(settings, (entry) => ({
    ...entry,
    ...(model.capabilities === undefined ? {} : { capabilities: { ...model.capabilities } }),
    ...(model.toolCalling === undefined ? {} : { toolCalling: model.toolCalling }),
  }));
  return model.answers === undefined ? entryChanged : withUpstreamConnection(entryChanged, (connection) => ({ ...connection, answers: model.answers }));
};

export const writeSettingsFile = (home: E2eHome, value: Readonly<Record<string, unknown>> | string): void => {
  const file = home.paths.settingsFile;
  const text = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
  settingsWriteCounter += 1;
  const temporary = path.join(path.dirname(file), `.settings-${process.pid}-${settingsWriteCounter}.tmp`);
  fs.writeFileSync(temporary, text, { mode: SETTINGS_FILE_MODE, flag: 'wx' });
  fs.renameSync(temporary, file);
};

export const writeDepsFile = (home: E2eHome, deps: E2eDeps, stackNumber: number, version: string = SUPERVISOR_APP_VERSION): string => {
  const file = path.join(home.root, `deps-${stackNumber}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...deps, version }), { mode: DEPS_FILE_MODE });
  return file;
};

export const supervisorArgv = (home: E2eHome, generation?: number): string[] => [`--home=${home.home}`, '--log-target=file', ...(generation === undefined ? [] : [`--generation=${generation}`])];

export const productSupervisorEnv = (home: E2eHome): Record<string, string> =>
  productTestEnv({
    PATH: SUPERVISOR_ENV_PATH,
    HOME: home.home,
    TMPDIR: home.root,
    LANG: 'C',
  });

export const supervisorEnv = (home: E2eHome, depsFile: string): Record<string, string> =>
  productTestEnv({
    PATH: SUPERVISOR_ENV_PATH,
    HOME: home.home,
    TMPDIR: home.root,
    LANG: 'C',
    [E2E_RUN_ENV]: home.run,
    [E2E_DEPS_ENV]: depsFile,
  });

const trimToUtf8Boundary = (bytes: Buffer): Buffer => {
  let start = 0;
  while (start < bytes.length && (bytes.readUInt8(start) & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION_BITS) start += 1;
  return bytes.subarray(start);
};

const describeExit = (exit: SupervisorExit): string => `code ${exit.code}, signal ${exit.signal}`;

type SupervisorLaunch = { command: string; args: readonly string[]; env: Record<string, string>; deps: E2eDeps; depsFile: string | undefined; script: string };

const PRODUCT_SELF = { kind: 'script', execPath: process.execPath, script: CLI_BUNDLE } as const;

const launchOf = (home: E2eHome, entry: SupervisorEntry, stackNumber: number): SupervisorLaunch => {
  if (entry.kind === 'product') {
    const invocation = superviseInvocation(PRODUCT_SELF, home.home, entry.generation, undefined);
    return { command: invocation.command, args: invocation.args, env: productSupervisorEnv(home), deps: {}, depsFile: undefined, script: CLI_BUNDLE };
  }
  const depsFile = writeDepsFile(home, entry.deps, stackNumber, entry.version);
  console.log(`e2e stack ${stackNumber}: the test entry, with the stated settings ${JSON.stringify(entry.deps)}`);
  const script = entry.script ?? SUPERVISOR_MAIN_PATH;
  return { command: process.execPath, args: [script, ...supervisorArgv(home, entry.generation)], env: supervisorEnv(home, depsFile), deps: entry.deps, depsFile, script };
};

export const spawnSupervisor = (options: SpawnSupervisorOptions): SpawnedSupervisor => {
  const { home, entry, stackNumber = 1 } = options;
  const { command, args, env, deps, depsFile, script } = launchOf(home, entry, stackNumber);
  const child = spawn(command, args, {
    env,
    cwd: home.root,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error(`the supervisor script ${script} did not start`);

  const stdoutLines: string[] = [];
  let stdoutBuffer = '';
  let stderrBytes: Buffer = Buffer.alloc(0);
  let exit: SupervisorExit | undefined;
  const readyGate = Promise.withResolvers<ReadyFields>();
  const exitGate = Promise.withResolvers<SupervisorExit>();
  void readyGate.promise.catch(() => undefined);

  const stderrTail = (): string => trimToUtf8Boundary(stderrBytes).toString('utf8');

  const onStdoutLine = (line: string): void => {
    const fields = parseReadyLine(line);
    if (fields !== undefined && fields.service === 'supervisor' && fields.pid === pid) {
      readyGate.resolve(fields);
      return;
    }
    stdoutLines.push(line);
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    for (let newline = stdoutBuffer.indexOf('\n'); newline >= 0; newline = stdoutBuffer.indexOf('\n')) {
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      onStdoutLine(line);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes = Buffer.concat([stderrBytes, chunk]).subarray(-STDERR_TAIL_BYTES);
  });
  const stdin = trackStreamErrors(child.stdin, 'the stdin pipe of the supervisor');
  child.once('error', (error) => readyGate.reject(error));
  child.once('exit', (code, signal) => {
    exit = { code, signal };
    exitGate.resolve(exit);
  });
  child.once('close', (code, signal) => {
    readyGate.reject(new Error(`the supervisor exited (code ${code}, signal ${signal}) before its ready line; stderr tail: ${stderrTail()}`));
  });

  const registered = home.ledger.add(pid, 'supervisor');
  registerE2eCleanup(async () => {
    await registered;
    if (exit === undefined) process.kill(pid, 'SIGKILL');
    await exitGate.promise;
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    stdin.assertHealthy();
  });

  const ready = async (deadlineMs = e2eStartBoundMs(deps)): Promise<ReadyFields> => {
    await registered;
    try {
      return await withinBound(readyGate.promise, deadlineMs, 'the supervisor printing its ready line');
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; stderr tail: ${stderrTail()}`, { cause: error });
    }
  };

  return { child, pid, depsFile, ready, exitState: () => exit, stdoutLines: () => [...stdoutLines], stderrTail, exited: exitGate.promise };
};

export type SandboxChoice = { kind: StackSandbox; sandboxFallback?: string };

export const sandboxChoiceOf = (options: StartStackOptions): SandboxChoice => {
  if (options.sandbox !== undefined) return { kind: options.sandbox };
  const resolution = resolveSandbox({ needsBash: options.needsBash ?? false });
  if (resolution.kind === 'skip') throw new Error(resolution.reason);
  if (resolution.kind === 'none') return { kind: 'none', sandboxFallback: resolution.sandboxFallback };
  return { kind: resolution.kind };
};

export const settingsOf = (home: E2eHome, kind: StackSandbox, options: StartStackOptions): Readonly<Record<string, unknown>> | string => {
  if (options.settingsText !== undefined) return options.settingsText;
  const base = options.model === undefined ? baseSettings(home, kind) : settingsWithModel(baseSettings(home, kind), options.model);
  const callerTools = options.settings?.['tools'] as Readonly<Record<string, unknown>> | undefined;
  return { ...base, ...options.settings, tools: { ...(base['tools'] as Readonly<Record<string, unknown>>), ...callerTools } };
};

const satisfied = (health: SupervisorHealth, wanted: StackReadiness): boolean =>
  health.phase === wanted.phase && ROLES.every((role) => health.children.find((child) => child.role === role)?.state === wanted.children[role]);

const RUNTIME_SERVING_ROLE = 'serving';

const runtimeRoleOf = async (home: E2eHome): Promise<unknown> => {
  const client = createUdsClient(fixedSocket(firstGeneration(home.paths).sockets.runtime), { connectTimeoutMs: 0 });
  try {
    const response = await client.request({ method: 'GET', path: '/v1/health' });
    const body: unknown = JSON.parse(await response.text());
    return typeof body === 'object' && body !== null && 'role' in body ? body.role : undefined;
  } finally {
    await client.close();
  }
};

const untilRuntimeServes = async (home: E2eHome, deadlineMs: number): Promise<void> => {
  await until(async () => (await runtimeRoleOf(home)) === RUNTIME_SERVING_ROLE, { deadlineMs, description: 'the runtime of the started generation to accept new work (role serving)' });
};

export const startUpstream = async (home: E2eHome, options: StartStackOptions): Promise<FakeChatCompletionsServer> => {
  if (options.upstream !== undefined) {
    if (options.script !== undefined) throw new Error('startStack: script cannot be combined with a caller-supplied upstream');
    if (options.routes !== undefined) throw new Error('startStack: routes cannot be combined with a caller-supplied upstream');
    return options.upstream;
  }
  const fake = await startFakeChatCompletions({
    scenario: 'tools-ok',
    contextWindow: options.model?.capabilities?.contextWindow ?? UPSTREAM_CONTEXT_WINDOW,
    maxConcurrency: 8,
    socketPath: home.upstreamSocket,
    ...(options.upstreamImageInput === undefined ? {} : { imageInput: options.upstreamImageInput }),
    ...(options.script === undefined ? {} : { script: options.script }),
    ...(options.routes === undefined ? {} : { routes: options.routes }),
  });
  registerE2eCleanup(() => fake.close());
  return fake;
};

const preparedOf = (options: StartStackOptions): number => {
  if (options.preparedGeneration === undefined) throw new Error('startStack: a product entry has either a started or a prepared generation');
  return options.preparedGeneration;
};

export const startStack = async (options: StartStackOptions): Promise<E2eStack> => {
  const { home } = options;
  if (options.settings !== undefined && 'sandbox' in options.settings) throw new Error('startStack: settings must not contain a sandbox key; use the sandbox option');
  const deps = options.deps ?? {};
  const choice = sandboxChoiceOf(options);
  const fake = await startUpstream(home, options);
  writeSettingsFile(home, settingsOf(home, choice.kind, options));
  const deadline = Date.now() + (options.readinessDeadlineMs ?? e2eStartBoundMs(deps));
  const remainingMs = (): number => Math.max(0, deadline - Date.now());
  const testEntry = options.deps !== undefined || options.supervisorScript !== undefined || options.version !== undefined;
  const started = testEntry || options.preparedGeneration !== undefined ? undefined : await startGenerationForTest(home.home, { version: cliPackage.version });
  const entry: SupervisorEntry = testEntry
    ? {
        kind: 'test',
        deps,
        ...(options.supervisorScript === undefined ? {} : { script: options.supervisorScript }),
        ...(options.version === undefined ? {} : { version: options.version }),
        ...(options.preparedGeneration === undefined ? {} : { generation: options.preparedGeneration }),
      }
    : { kind: 'product', generation: started?.generation ?? preparedOf(options) };
  const supervisor = spawnSupervisor({ home, entry, stackNumber: 1 });
  const ready = await supervisor.ready(remainingMs()).finally(() => started?.release());
  const client = createSupervisorClient(home);
  registerE2eCleanup(() => client.close());

  let health: SupervisorHealth;
  if (options.readiness === false) {
    health = await client.health();
  } else {
    const wanted: StackReadiness = { ...DEFAULT_READINESS, ...options.readiness };
    let last: SupervisorHealth | undefined;
    const polling = new AbortController();
    const exitedEarly = supervisor.exited.then((exit): never => {
      throw new Error(`the supervisor exited (${describeExit(exit)}) while waiting for readiness`);
    });
    try {
      health = await Promise.race([
        until(
          async () => {
            const current = await client.health();
            last = current;
            return satisfied(current, wanted) ? current : undefined;
          },
          {
            deadlineMs: remainingMs(),
            description: `supervisor phase ${wanted.phase} with gateway ${wanted.children.gateway} and runtime ${wanted.children.runtime}`,
            signal: polling.signal,
          },
        ),
        exitedEarly,
      ]);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nlast health: ${JSON.stringify(last)}\nsupervisor stderr tail: ${supervisor.stderrTail()}`, { cause: error });
    } finally {
      polling.abort();
    }
    if (satisfied(health, DEFAULT_READINESS)) await untilRuntimeServes(home, remainingMs());
  }

  return {
    home,
    fake,
    routeHits: fake.routeHits,
    supervisor,
    ready,
    client,
    sandbox: choice.kind,
    ...(choice.sandboxFallback === undefined ? {} : { sandboxFallback: choice.sandboxFallback }),
    health,
  };
};

export const shutdownBarrier = async (stack: E2eStack): Promise<void> => {
  let exit: SupervisorExit | undefined;
  void stack.supervisor.exited.then((value) => {
    exit = value;
  });
  const response = await stack.client.shutdown();
  expect(response.status).toBe(202);
  expect(response.body.phase).toBe('draining');
  const settled = await until(() => exit, { deadlineMs: E2E_SUPERVISOR_CLOSE_BOUND_MS, description: 'supervisor exited after POST /v1/shutdown' });
  expect(settled).toEqual({ code: 0, signal: null });
  await stack.home.ledger.collect({});
  expect(await stack.home.ledger.survivors()).toEqual([]);
};
