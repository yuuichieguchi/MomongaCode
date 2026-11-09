import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { expect } from 'vitest';
import type { SandboxSetting } from '@momonga/config';
import { parseReadyLine } from '@momonga/foundation';
import type { ReadyFields } from '@momonga/foundation';
import type { SupervisorChildState, SupervisorHealth, SupervisorPhase, TargetAnswers } from '@momonga/protocol';
import type { ChildRole } from '@momonga/supervisor';
import { startFakeChatCompletions } from '@momonga/testkit';
import type { FakeChatCompletionsServer, FakeRoute, FakeScriptedReply } from '@momonga/testkit';
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
import { E2E_DRAIN_TIMEOUT_MS, E2E_LEASE_MS, E2E_SUPERVISOR_CLOSE_BOUND_MS, e2eStartBoundMs, until, withinBound } from './wait.ts';
import { pinnedRipgrepPath } from '../../test/support/pinned-ripgrep.ts';

export const SUPERVISOR_MAIN_PATH = path.join(REPO_ROOT, 'e2e', 'support', 'supervisor-main.ts');
export { SUPERVISOR_APP_VERSION };
export const SUPERVISOR_ENV_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
export const STDERR_TAIL_BYTES = 64 * 1024;
export const UPSTREAM_MODEL = 'system';
export const UPSTREAM_TARGET = 'primary';
export const STRUCTURED_TARGET = 'structured';
export const UPSTREAM_CONTEXT_WINDOW = 8192;

export const DEFAULT_E2E_DEPS: E2eDeps = {
  runtime: { leaseMs: E2E_LEASE_MS, drainTimeoutMs: E2E_DRAIN_TIMEOUT_MS, workerCount: 1 },
};

export type StackSandbox = SandboxSetting;

export type StackReadiness = { phase: SupervisorPhase; children: Readonly<Record<ChildRole, SupervisorChildState>> };

export type StackTargetCapabilities = { readonly contextWindow: number; readonly maxOutputTokens: number };

export type StackTarget = { readonly capabilities?: StackTargetCapabilities; readonly toolCalling?: 'native' | 'constrained'; readonly answers?: 'model' | 'script' };

export type StartStackOptions = {
  home: E2eHome;
  needsBash?: boolean;
  sandbox?: StackSandbox;
  settings?: Readonly<Record<string, unknown>>;
  settingsText?: string;
  deps?: E2eDeps;
  script?: FakeScriptedReply[];
  routes?: FakeRoute[];
  target?: StackTarget;
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
  readonly depsFile: string;
  ready(deadlineMs?: number): Promise<ReadyFields>;
  exitState(): SupervisorExit | undefined;
  stdoutLines(): readonly string[];
  stderrTail(): string;
  exited: Promise<SupervisorExit>;
};

export type SpawnSupervisorOptions = { home: E2eHome; deps?: E2eDeps; stackNumber?: number; script?: string; version?: string };

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

export const baseSettings = (home: E2eHome, sandbox: StackSandbox): Record<string, unknown> => ({
  models: {
    aliases: { default: [UPSTREAM_TARGET] },
    targets: {
      [UPSTREAM_TARGET]: {
        adapter: 'chat-completions',
        provider: 'fake',
        model: UPSTREAM_MODEL,
        answers: 'script' satisfies TargetAnswers,
        socketPath: home.upstreamSocket,
        capabilities: { contextWindow: UPSTREAM_CONTEXT_WINDOW, maxOutputTokens: 1024 },
      },
    },
  },
  sandbox,
  tools: { ripgrep: pinnedRipgrepPath() },
});

export const withStructuredAlias = (settings: Readonly<Record<string, unknown>>, alias: string): Record<string, unknown> => {
  const models = settings['models'] as { aliases: Record<string, unknown>; targets: Record<string, { capabilities: Record<string, unknown> }> };
  const upstream = models.targets[UPSTREAM_TARGET];
  if (upstream === undefined) throw new Error(`withStructuredAlias: no ${UPSTREAM_TARGET} target to derive ${STRUCTURED_TARGET} from`);
  return {
    ...settings,
    models: {
      ...models,
      aliases: { ...models.aliases, [alias]: [STRUCTURED_TARGET] },
      targets: { ...models.targets, [STRUCTURED_TARGET]: { ...upstream, capabilities: { ...upstream.capabilities, structuredOutput: 'json_schema' } } },
    },
  };
};

export const withClassifierAlias = (settings: Readonly<Record<string, unknown>>, alias: string): Record<string, unknown> => ({
  ...withStructuredAlias(settings, alias),
  autoMode: { classifier: alias },
});

export type StructuredRole = 'reflection' | 'analysis';

export const withStructuredRole = (settings: Readonly<Record<string, unknown>>, role: StructuredRole, alias: string): Record<string, unknown> => {
  const structured = withStructuredAlias(settings, alias);
  const models = structured['models'] as { roles?: Record<string, unknown> };
  return { ...structured, models: { ...models, roles: { ...models.roles, [role]: alias } } };
};

export const withTargetsAnswering = (settings: Readonly<Record<string, unknown>>, answers: TargetAnswers): Record<string, unknown> => {
  const models = settings['models'] as { targets: Record<string, Record<string, unknown>> };
  return {
    ...settings,
    models: { ...models, targets: Object.fromEntries(Object.entries(models.targets).map(([name, target]) => [name, { ...target, answers }])) },
  };
};

export const contextWindowOf = (home: E2eHome): number => {
  const models = baseSettings(home, 'none')['models'] as { targets: Record<string, { capabilities: { contextWindow: number } }> };
  return (models.targets[UPSTREAM_TARGET] as { capabilities: { contextWindow: number } }).capabilities.contextWindow;
};

export const settingsWithTarget = (settings: Readonly<Record<string, unknown>>, target: StackTarget): Record<string, unknown> => {
  const models = settings['models'] as { aliases: unknown; targets: Record<string, Record<string, unknown>> };
  const primary = models.targets[UPSTREAM_TARGET];
  if (primary === undefined) throw new Error(`settingsWithTarget: no ${UPSTREAM_TARGET} target to override`);
  return {
    ...settings,
    models: {
      ...models,
      targets: {
        ...models.targets,
        [UPSTREAM_TARGET]: {
          ...primary,
          ...(target.capabilities === undefined ? {} : { capabilities: { ...target.capabilities } }),
          ...(target.toolCalling === undefined ? {} : { toolCalling: target.toolCalling }),
          ...(target.answers === undefined ? {} : { answers: target.answers }),
        },
      },
    },
  };
};

export const writeSettingsFile = (home: E2eHome, value: Readonly<Record<string, unknown>> | string): void => {
  const target = home.paths.settingsFile;
  const text = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
  settingsWriteCounter += 1;
  const temporary = path.join(path.dirname(target), `.settings-${process.pid}-${settingsWriteCounter}.tmp`);
  fs.writeFileSync(temporary, text, { mode: SETTINGS_FILE_MODE, flag: 'wx' });
  fs.renameSync(temporary, target);
};

export const writeDepsFile = (home: E2eHome, deps: E2eDeps, stackNumber: number, version: string = SUPERVISOR_APP_VERSION): string => {
  const file = path.join(home.root, `deps-${stackNumber}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...deps, version }), { mode: DEPS_FILE_MODE });
  return file;
};

export const supervisorArgv = (home: E2eHome): string[] => [`--home=${home.home}`, '--log-target=file'];

export const supervisorEnv = (home: E2eHome, depsFile: string): Record<string, string> => ({
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

export const spawnSupervisor = (options: SpawnSupervisorOptions): SpawnedSupervisor => {
  const { home, deps = DEFAULT_E2E_DEPS, stackNumber = 1, script = SUPERVISOR_MAIN_PATH, version } = options;
  const depsFile = writeDepsFile(home, deps, stackNumber, version);
  const child = spawn(process.execPath, [script, ...supervisorArgv(home)], {
    env: supervisorEnv(home, depsFile),
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
  const base = options.target === undefined ? baseSettings(home, kind) : settingsWithTarget(baseSettings(home, kind), options.target);
  const callerTools = options.settings?.['tools'] as Readonly<Record<string, unknown>> | undefined;
  return { ...base, ...options.settings, tools: { ...(base['tools'] as Readonly<Record<string, unknown>>), ...callerTools } };
};

const satisfied = (health: SupervisorHealth, wanted: StackReadiness): boolean =>
  health.phase === wanted.phase && ROLES.every((role) => health.children.find((child) => child.role === role)?.state === wanted.children[role]);

export const startUpstream = async (home: E2eHome, options: StartStackOptions): Promise<FakeChatCompletionsServer> => {
  if (options.upstream !== undefined) {
    if (options.script !== undefined) throw new Error('startStack: script cannot be combined with a caller-supplied upstream');
    if (options.routes !== undefined) throw new Error('startStack: routes cannot be combined with a caller-supplied upstream');
    return options.upstream;
  }
  const fake = await startFakeChatCompletions({
    scenario: 'tools-ok',
    contextWindow: options.target?.capabilities?.contextWindow ?? UPSTREAM_CONTEXT_WINDOW,
    maxConcurrency: 8,
    socketPath: home.upstreamSocket,
    ...(options.upstreamImageInput === undefined ? {} : { imageInput: options.upstreamImageInput }),
    ...(options.script === undefined ? {} : { script: options.script }),
    ...(options.routes === undefined ? {} : { routes: options.routes }),
  });
  registerE2eCleanup(() => fake.close());
  return fake;
};

export const startStack = async (options: StartStackOptions): Promise<E2eStack> => {
  const { home } = options;
  if (options.settings !== undefined && 'sandbox' in options.settings) throw new Error('startStack: settings must not contain a sandbox key; use the sandbox option');
  const deps = options.deps ?? DEFAULT_E2E_DEPS;
  const choice = sandboxChoiceOf(options);
  const fake = await startUpstream(home, options);
  writeSettingsFile(home, settingsOf(home, choice.kind, options));
  const deadline = Date.now() + (options.readinessDeadlineMs ?? e2eStartBoundMs(deps));
  const remainingMs = (): number => Math.max(0, deadline - Date.now());
  const supervisor = spawnSupervisor({ home, deps, stackNumber: 1, ...(options.supervisorScript === undefined ? {} : { script: options.supervisorScript }), ...(options.version === undefined ? {} : { version: options.version }) });
  const ready = await supervisor.ready(remainingMs());
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
};
