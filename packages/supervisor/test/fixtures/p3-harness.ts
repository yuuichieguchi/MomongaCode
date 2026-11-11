import { AsyncResource } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createJsonLogger, momongaPaths, fixedSocket } from '@momonga/foundation';
import type { JsonLogger, MomongaPaths, TextStream } from '@momonga/foundation';
import type { SupervisorHealth } from '@momonga/protocol';
import { createFakeClock, createFakeTimers, createRealWorkScope, driveFakeTime, prepareGenerationForTest, quiesce, registerCleanup, registerOwned, settleRealWork, waitFor, withTempDir, testKernelLock, testProcessInspector } from '@momonga/testkit';
import type { CleanupContext, FakeClock, FakeTimers, JsonLine, RealWorkScope } from '@momonga/testkit';

export { createRealWorkScope, quiesce };
export type { RealWorkScope };
import type { ChildExit, ChildHandle, SpawnPort, SpawnPortOptions } from '../../src/child-manager.ts';
import type { ChildRole } from '../../src/launcher.ts';
import { nodeMarkerFiles } from '../../src/orphans.ts';
import type { MarkerPorts } from '../../src/orphans.ts';
import { startSupervisor } from '../../src/start-supervisor.ts';
import type { SupervisorOptions, SupervisorProcess } from '../../src/start-supervisor.ts';
import { modelSettings, testHostPath } from '@momonga/testkit';
import type { ModelSpec } from '@momonga/testkit';

export const T0 = Date.parse('2026-01-01T00:00:00.000Z');
export const HARNESS_CLOSE_BOUND_MS = 2_000_000;
export const TEST_VERSION = '9.9.9-test';
export const HARNESS_GENERATION = 1;

export type CapturedLog = {
  readonly logger: JsonLogger;
  readonly stream: TextStream;
  lines(): JsonLine[];
  messages(): string[];
  withMsg(msg: string): JsonLine[];
};

export const captureLog = (clock: { now(): number }, service = 'supervisor'): CapturedLog => {
  const raw: string[] = [];
  const stream: TextStream = {
    write: (chunk) => {
      for (const line of chunk.split('\n')) if (line !== '') raw.push(line);
      return true;
    },
  };
  const lines = (): JsonLine[] => raw.map((line) => JSON.parse(line) as JsonLine);
  return {
    logger: createJsonLogger({ service, clock, stream }),
    stream,
    lines,
    messages: () => lines().map((line) => String(line.msg)),
    withMsg: (msg) => lines().filter((line) => line.msg === msg),
  };
};

export type CapturedText = TextStream & { text(): string; lines(): string[] };

export const captureText = (onWrite?: (chunk: string) => void): CapturedText => {
  let text = '';
  return {
    write: (chunk) => {
      text += chunk;
      onWrite?.(chunk);
      return true;
    },
    text: () => text,
    lines: () => text.split('\n').filter((line) => line !== ''),
  };
};

export type TermReaction = 'exit0' | 'exit1' | 'ignore';
export type KillReaction = 'die' | 'ignore';

export type ChildBehaviour = {
  autoReady: boolean;
  holdPipes: boolean;
  onTerm: TermReaction;
  onInt: TermReaction;
  onKill: KillReaction;
  readyVersion?: string;
};

export const DEFAULT_BEHAVIOUR: ChildBehaviour = { autoReady: true, holdPipes: false, onTerm: 'exit0', onInt: 'exit0', onKill: 'die' };

export type FakeChild = {
  readonly index: number;
  readonly role: ChildRole;
  readonly pid: number;
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnPortOptions;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly lifeline: PassThrough;
  readonly signals: NodeJS.Signals[];
  groupKills: number;
  behaviour: ChildBehaviour;
  exited: ChildExit | undefined;
  ready(fields?: { service?: string; pid?: number; version?: string }): void;
  exit(code: number | null, signal?: NodeJS.Signals | null): void;
  writeStdout(line: string): void;
  writeStderr(line: string): void;
};

export type SpawnEvent = { kind: 'spawn' | 'kill' | 'killGroup' | 'exit'; role: ChildRole; pid: number; at: number; detail?: string };

export type FakeSpawn = {
  readonly port: SpawnPort;
  readonly children: FakeChild[];
  readonly events: SpawnEvent[];
  readonly order: string[];
  of(role: ChildRole): FakeChild[];
  latest(role: ChildRole): FakeChild;
  spawnCount(role?: ChildRole): number;
  setBehaviour(role: ChildRole, behaviour: Partial<ChildBehaviour>): void;
  failNext(role: ChildRole, mode: 'throw' | 'async'): void;
  dieOnAnySignal(): void;
};

export const roleOfCommand = (command: string): ChildRole => {
  const base = path.basename(command);
  if (base === 'gateway' || base === 'runtime') return base;
  throw new Error(`fake launcher command ${command} names no role`);
};

export const fakeLauncher = (role: ChildRole): { command: string; args: readonly string[] } => ({ command: `/fake/bin/${role}`, args: [`/fake/src/${role}.ts`] });

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`spawn ${code}`), { code });

export type FakeSpawnOptions = {
  clock?: { now(): number };
  firstPid?: number;
  record?: string[];
  behaviours?: Partial<Record<ChildRole, Partial<ChildBehaviour>>>;
  realWork?: RealWorkScope;
};

export const createFakeSpawn = (options: FakeSpawnOptions = {}): FakeSpawn => {
  const scoped = <T>(fn: () => T): T => (options.realWork === undefined ? fn() : options.realWork.run(fn));
  const later = (fn: () => void): void => scoped(() => void setImmediate(fn));
  const children: FakeChild[] = [];
  const events: SpawnEvent[] = [];
  const order = options.record ?? [];
  const behaviours: Record<ChildRole, ChildBehaviour> = {
    gateway: { ...DEFAULT_BEHAVIOUR, ...options.behaviours?.gateway },
    runtime: { ...DEFAULT_BEHAVIOUR, ...options.behaviours?.runtime },
  };
  const failures: Record<ChildRole, Array<'throw' | 'async'>> = { gateway: [], runtime: [] };
  let nextPid = options.firstPid ?? 4_100_000;
  let everyoneDies = false;
  const now = (): number => options.clock?.now() ?? Number.NaN;

  const port: SpawnPort = (command, args, spawnOptions) => {
    const role = roleOfCommand(command);
    const failure = failures[role].shift();
    if (failure === 'throw') {
      order.push(`spawn-throw:${role}`);
      throw errno('ENOENT');
    }
    const exitListeners: Array<(exit: ChildExit) => void> = [];
    const errorListeners: Array<(error: NodeJS.ErrnoException) => void> = [];
    if (failure === 'async') {
      order.push(`spawn-error:${role}`);
      const handle: ChildHandle = {
        pid: undefined,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        lifeline: null,
        onSpawnError: (listener) => void errorListeners.push(listener),
        onExit: (listener) => void exitListeners.push(listener),
        kill: () => undefined,
        killGroup: async () => undefined,
      };
      later(() => {
        for (const listener of errorListeners) listener(errno('ENOENT'));
      });
      return handle;
    }
    const pid = nextPid;
    nextPid += 1;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const lifeline = new PassThrough();
    const child: FakeChild = {
      index: children.length,
      role,
      pid,
      command,
      args: [...args],
      options: spawnOptions,
      stdout,
      stderr,
      lifeline,
      signals: [],
      groupKills: 0,
      behaviour: { ...behaviours[role] },
      exited: undefined,
      ready: (fields = {}) => {
        scoped(() => stdout.write(
          `${JSON.stringify({ event: 'ready', service: fields.service ?? role, pid: fields.pid ?? pid, version: fields.version ?? child.behaviour.readyVersion ?? TEST_VERSION, socketPath: `/fake/run/${role}.sock`, startedAt: new Date(T0).toISOString() })}\n`,
        ));
      },
      exit: (code, signal = null) => scoped(() => {
        if (child.exited !== undefined) return;
        child.exited = { code, signal };
        events.push({ kind: 'exit', role, pid, at: now(), detail: `${code}:${signal}` });
        order.push(`exit:${role}`);
        if (!child.behaviour.holdPipes) {
          stdout.end();
          stderr.end();
        }
        for (const listener of exitListeners) listener({ code, signal });
      }),
      writeStdout: (line) => scoped(() => void stdout.write(`${line}\n`)),
      writeStderr: (line) => scoped(() => void stderr.write(`${line}\n`)),
    };
    const react = (reaction: TermReaction): void => {
      if (reaction === 'ignore') return;
      later(() => child.exit(reaction === 'exit0' ? 0 : 1));
    };
    const handle: ChildHandle = {
      pid,
      stdout,
      stderr,
      lifeline,
      onSpawnError: (listener) => void errorListeners.push(listener),
      onExit: (listener) => void exitListeners.push(listener),
      kill: (signal) => {
        child.signals.push(signal);
        events.push({ kind: 'kill', role, pid, at: now(), detail: signal });
        order.push(`${signal}:${role}`);
        if (child.exited !== undefined) return;
        if (everyoneDies) {
          later(() => child.exit(null, signal));
          return;
        }
        if (signal === 'SIGTERM') react(child.behaviour.onTerm);
        else if (signal === 'SIGINT') react(child.behaviour.onInt);
        else if (signal === 'SIGKILL' && child.behaviour.onKill === 'die') later(() => child.exit(null, 'SIGKILL'));
      },
      killGroup: async () => {
        child.groupKills += 1;
        events.push({ kind: 'killGroup', role, pid, at: now() });
        order.push(`SIGKILL-group:${role}`);
        if (child.exited !== undefined) return;
        if (everyoneDies || child.behaviour.onKill === 'die') later(() => child.exit(null, 'SIGKILL'));
      },
    };
    children.push(child);
    events.push({ kind: 'spawn', role, pid, at: now() });
    order.push(`spawn:${role}`);
    if (child.behaviour.autoReady) later(() => child.ready());
    return handle;
  };

  return {
    port,
    children,
    events,
    order,
    of: (role) => children.filter((child) => child.role === role),
    latest: (role) => {
      const list = children.filter((child) => child.role === role);
      const last = list[list.length - 1];
      if (last === undefined) throw new Error(`no ${role} was spawned`);
      return last;
    },
    spawnCount: (role) => (role === undefined ? children.length : children.filter((child) => child.role === role).length),
    setBehaviour: (role, behaviour) => {
      behaviours[role] = { ...behaviours[role], ...behaviour };
      for (const child of children) if (child.role === role && child.exited === undefined) child.behaviour = { ...child.behaviour, ...behaviour };
    },
    failNext: (role, mode) => void failures[role].push(mode),
    dieOnAnySignal: () => {
      everyoneDies = true;
      for (const child of children) if (child.exited === undefined && (child.signals.length > 0 || child.groupKills > 0)) later(() => child.exit(null, 'SIGKILL'));
    },
  };
};

export const CHAT_CAPABILITIES = { contextWindow: 128000, maxOutputTokens: 4096 };

export const chatModel = (provider: string, overrides: { id?: string; apiKeyEnv?: string } = {}): ModelSpec => ({
  provider,
  id: overrides.id ?? 'gpt-x',
  baseUrl: 'https://api.example.com/v1',
  capabilities: CHAT_CAPABILITIES,
  ...(overrides.apiKeyEnv === undefined ? {} : { apiKeyEnv: overrides.apiKeyEnv }),
});

export const REMOTE_PROVIDER = 'remote';

export const validSettings = (overrides: { model?: string; sandbox?: 'seatbelt' | 'none'; apiKeyEnv?: string; permissions?: unknown; added?: readonly ModelSpec[] } = {}): Record<string, unknown> => ({
  ...modelSettings({
    models: [
      chatModel(REMOTE_PROVIDER, { ...(overrides.model === undefined ? {} : { id: overrides.model }), ...(overrides.apiKeyEnv === undefined ? {} : { apiKeyEnv: overrides.apiKeyEnv }) }),
      ...(overrides.added ?? []),
    ],
  }),
  ...(overrides.sandbox === undefined ? {} : { sandbox: overrides.sandbox }),
  ...(overrides.permissions === undefined ? {} : { permissions: overrides.permissions }),
});

let settingsWrites = 0;

export const writeSettingsText = (home: string, text: string): void => {
  const root = path.join(home, '.momonga');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, 'settings.json');
  settingsWrites += 1;
  const temporary = path.join(root, `.settings-${process.pid}-${settingsWrites}.tmp`);
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, file);
  const stamp = new Date(T0 + settingsWrites * 1000);
  fs.utimesSync(file, stamp, stamp);
};

export const writeSettings = (home: string, value: unknown): void => writeSettingsText(home, JSON.stringify(value, null, 2));

export const INVALID_SETTINGS_TEXT = '{ "models": ';

export type MarkerCalls = {
  findHolders: string[];
  reapMarkerDirectory: Array<Parameters<NonNullable<MarkerPorts['reapMarkerDirectory']>>[0]>;
  reapMarkedProcesses: Array<Parameters<NonNullable<MarkerPorts['reapMarkedProcesses']>>[0]>;
};

export const recordingMarkerPorts = (overrides: MarkerPorts = {}, record?: string[]): { ports: Required<MarkerPorts>; calls: MarkerCalls } => {
  const calls: MarkerCalls = { findHolders: [], reapMarkerDirectory: [], reapMarkedProcesses: [] };
  const ports: Required<MarkerPorts> = {
    files: overrides.files ?? nodeMarkerFiles,
    findHolders: async (marker, probe) => {
      calls.findHolders.push(marker);
      record?.push('findHolders');
      return overrides.findHolders === undefined ? [] : overrides.findHolders(marker, probe);
    },
    reapMarkerDirectory: async (options) => {
      calls.reapMarkerDirectory.push(options);
      record?.push('reapMarkerDirectory');
      return overrides.reapMarkerDirectory === undefined ? { reaped: 0, kept: 0, unreaped: [] } : overrides.reapMarkerDirectory(options);
    },
    reapMarkedProcesses: async (options) => {
      calls.reapMarkedProcesses.push(options);
      record?.push('reapMarkedProcesses');
      if (overrides.reapMarkedProcesses !== undefined) return overrides.reapMarkedProcesses(options);
      fs.rmSync(options.marker, { force: true });
      return { removed: true };
    },
    listMarkers: (markersDir) => (overrides.listMarkers === undefined ? fs.promises.readdir(markersDir) : overrides.listMarkers(markersDir)),
  };
  return { ports, calls };
};

export const pump = async (timers: FakeTimers, realWork: RealWorkScope, ms: number): Promise<void> => {
  const target = timers.monotonicMs() + ms;
  await driveFakeTime(timers, {
    done: () => {
      const due = timers.nextDueAt();
      return due === undefined || due > target;
    },
    horizonAt: target,
    description: 'fake time to pump',
    settle: () => settleRealWork(realWork, () => false, 'fake time to pump'),
    detail: () => realWork.describe(),
  });
  await timers.advanceAsync(Math.max(0, target - timers.monotonicMs()));
  await settleRealWork(realWork, () => false, 'fake time pumped');
};

export const pumpUntil = async (
  timers: FakeTimers,
  predicate: () => boolean,
  options: { realWork: RealWorkScope; maxMs?: number; description?: string },
): Promise<void> => {
  const { realWork } = options;
  const maxMs = options.maxMs ?? 600_000;
  const description = options.description ?? 'condition';
  await driveFakeTime(timers, {
    done: predicate,
    horizonAt: timers.now() + maxMs,
    description,
    settle: () => settleRealWork(realWork, predicate, description),
    quiet: () => !realWork.inFlight(),
    detail: () => realWork.describe(),
  });
};

export const settledFlag = <T>(promise: Promise<T>): { settled(): boolean; value(): T | undefined; promise: Promise<T> } => {
  let done = false;
  let result: T | undefined;
  promise.then(
    (value) => {
      done = true;
      result = value;
    },
    () => {
      done = true;
    },
  );
  return { settled: () => done, value: () => result, promise };
};

export type Harness = {
  readonly home: string;
  readonly paths: MomongaPaths;
  readonly clock: FakeClock;
  readonly timers: FakeTimers;
  readonly realWork: RealWorkScope;
  readonly fake: FakeSpawn;
  readonly log: CapturedLog;
  readonly stdout: CapturedText;
  readonly markers: { ports: Required<MarkerPorts>; calls: MarkerCalls };
  readonly order: string[];
  readonly supervisor: SupervisorProcess;
  readonly successorLaunches: number[];
  health(): SupervisorHealth;
  child(role: ChildRole): SupervisorHealth['children'][number];
  waitForState(role: ChildRole, state: string, maxMs?: number): Promise<void>;
};

export type HarnessOptions = {
  settings?: unknown;
  settingsText?: string;
  markerPorts?: MarkerPorts;
  generation?: number;
  overrides?: Partial<Omit<SupervisorOptions, 'spawn' | 'home' | 'version' | 'generation' | 'launcher' | 'clock' | 'timers' | 'logger' | 'stdout' | 'markerPorts'>> & {
    launcher?: SupervisorOptions['launcher'];
  };
  home?: string;
  order?: string[];
  behaviours?: Partial<Record<ChildRole, Partial<ChildBehaviour>>>;
  onStdout?: (chunk: string) => void;
  prepare?: (home: string, paths: MomongaPaths) => void;
};

export const prepareHome = (context: CleanupContext): { home: string; paths: MomongaPaths } => {
  const home = withTempDir(context, { asHome: true });
  return { home, paths: momongaPaths(home, process.platform, process.env) };
};

export const startHarness = async (context: CleanupContext, options: HarnessOptions = {}): Promise<Harness> => {
  const home = options.home ?? withTempDir(context, { asHome: true });
  const paths = momongaPaths(home, process.platform, process.env);
  if (options.settingsText !== undefined) writeSettingsText(home, options.settingsText);
  else writeSettings(home, options.settings ?? validSettings());
  const generation = options.generation ?? HARNESS_GENERATION;
  prepareGenerationForTest(home, generation, TEST_VERSION);
  options.prepare?.(home, paths);
  const successorLaunches: number[] = [];
  const realWork = createRealWorkScope();
  const clock = createFakeClock(T0);
  const timers = createFakeTimers(clock);
  const order: string[] = options.order ?? [];
  const fake = createFakeSpawn({ clock, realWork, record: order, ...(options.behaviours === undefined ? {} : { behaviours: options.behaviours }) });
  const log = captureLog(clock);
  const stdout = captureText((chunk) => {
    order.push('ready');
    options.onStdout?.(chunk);
  });
  const markers = recordingMarkerPorts(options.markerPorts ?? {}, order);
  const abortAtCleanup = async (process: SupervisorProcess): Promise<void> => {
    fake.dieOnAnySignal();
    const closing = settledFlag(realWork.run(() => process.abort()));
    await pumpUntil(timers, () => closing.settled(), { realWork, maxMs: HARNESS_CLOSE_BOUND_MS, description: 'harness abort settles' });
  };
  const started = await registerOwned(context, () => realWork.run(() => startSupervisor({
    lockMechanism: testKernelLock(),
    inspector: testProcessInspector(),
    home,
    version: TEST_VERSION,
    generation,
    childCounts: async () => ({}),
    successorLauncher: {
      launch: (successor) => {
        successorLaunches.push(successor);
        order.push(`successor:${successor}`);
        return { pid: undefined };
      },
    },
    launcher: options.overrides?.launcher ?? fakeLauncher,
    env: { PATH: testHostPath('/usr/bin:/bin'), HOME: home, LANG: 'C' },
    clock,
    timers,
    logger: log.logger,
    stdout,
    spawn: fake.port,
    markerPorts: markers.ports,
    random: () => 0.5,
    watchSettings: false,
    ...options.overrides,
  })), abortAtCleanup);
  const supervisor: SupervisorProcess = {
    ...started,
    close: () => realWork.run(() => started.close()),
    abort: () => realWork.run(() => started.abort()),
  };
  const health = (): SupervisorHealth => supervisor.health();
  const child = (role: ChildRole): SupervisorHealth['children'][number] => {
    const found = health().children.find((entry) => entry.role === role);
    if (found === undefined) throw new Error(`health has no ${role}`);
    return found;
  };
  return {
    home,
    paths,
    clock,
    timers,
    realWork,
    fake,
    log,
    stdout,
    markers,
    order,
    supervisor,
    successorLaunches,
    health,
    child,
    waitForState: async (role, state, maxMs = 120_000) => {
      await pumpUntil(timers, () => child(role).state === state, { realWork, maxMs, description: `${role} ${state}` });
    },
  };
};

export const waitTurns = (predicate: () => boolean, description: string): Promise<void> => waitFor(predicate, { description, maxTurns: 50_000 });

export type SimpleResponse = { status: number; headers: Record<string, string>; text: string };

export const httpOver = async (
  context: CleanupContext,
  socketPath: string,
  method: string,
  requestPath: string,
  body?: string,
): Promise<SimpleResponse> => {
  const { createUdsClient } = await import('@momonga/foundation');
  const client = createUdsClient(fixedSocket(socketPath), { connectTimeoutMs: 0, headersTimeoutMs: 5000 });
  registerCleanup(context, () => client.destroy());
  const response = await client.request({ method, path: requestPath, ...(body === undefined ? {} : { body, headers: { 'content-type': 'application/json' } }) });
  const text = await response.text();
  await client.close();
  return { status: response.status, headers: response.headers, text };
};

export const writeMarker = (paths: MomongaPaths, name: string): string => {
  fs.mkdirSync(paths.markers.daemons, { recursive: true, mode: 0o700 });
  const marker = path.join(paths.markers.daemons, name);
  fs.writeFileSync(marker, '', { mode: 0o600 });
  return marker;
};

export const phaseChanges = (log: CapturedLog): string[] => log.withMsg('phase.change').map((line) => `${String(line['from'])}->${String(line['to'])}`);

export type FakeSettingsWatch = { watch: typeof fs.watch; fire(filename?: string | null): void; directories: string[]; closed(): number };

export const fakeSettingsWatch = (): FakeSettingsWatch => {
  const emitters: EventEmitter[] = [];
  const directories: string[] = [];
  let closed = 0;
  const watch = ((directory: string, ...rest: unknown[]) => {
    directories.push(directory);
    const listener = rest.find((value): value is (eventType: string, filename: string | null) => void => typeof value === 'function');
    const emitter = Object.assign(new EventEmitter(), {
      close: () => {
        closed += 1;
      },
    });
    if (listener !== undefined) emitter.on('change', AsyncResource.bind(listener));
    emitters.push(emitter);
    return emitter;
  }) as unknown as typeof fs.watch;
  return {
    watch,
    directories,
    closed: () => closed,
    fire: (filename = 'settings.json') => {
      for (const emitter of emitters) emitter.emit('change', 'rename', filename);
    },
  };
};

export type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };

export const deferred = <T>(): Deferred<T> => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

export const markerRole = (marker: string): string => path.basename(marker).split('-')[0] ?? '';

export const writeLockFile = (lockPath: string, pid: number, mtimeMs?: number): void => {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(lockPath, String(pid), { mode: 0o600 });
  if (mtimeMs !== undefined) fs.utimesSync(lockPath, mtimeMs / 1000, mtimeMs / 1000);
};

