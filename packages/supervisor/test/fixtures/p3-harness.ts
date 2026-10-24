import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createJsonLogger, momongaPaths } from '@momonga/foundation';
import type { JsonLogger, MomongaPaths, TextStream } from '@momonga/foundation';
import type { SupervisorHealth } from '@momonga/protocol';
import { createFakeClock, createFakeTimers, registerCleanup, waitFor, withTempDir } from '@momonga/testkit';
import type { CleanupContext, FakeClock, FakeTimers, JsonLine } from '@momonga/testkit';
import type { ChildExit, ChildHandle, SpawnPort, SpawnPortOptions } from '../../src/child-manager.ts';
import type { ChildRole } from '../../src/launcher.ts';
import type { MarkerPorts } from '../../src/orphans.ts';
import { startSupervisor } from '../../src/start-supervisor.ts';
import type { SupervisorOptions, SupervisorProcess } from '../../src/start-supervisor.ts';

export const T0 = Date.parse('2026-01-01T00:00:00.000Z');
export const TEST_VERSION = '9.9.9-test';

export const turns = async (count = 20): Promise<void> => {
  for (let index = 0; index < count; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

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
  ready(fields?: { service?: string; pid?: number }): void;
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

export const createFakeSpawn = (options: { clock?: { now(): number }; firstPid?: number; record?: string[]; behaviours?: Partial<Record<ChildRole, Partial<ChildBehaviour>>> } = {}): FakeSpawn => {
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
        killGroup: () => undefined,
      };
      setImmediate(() => {
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
        stdout.write(
          `${JSON.stringify({ event: 'ready', service: fields.service ?? role, pid: fields.pid ?? pid, version: TEST_VERSION, socketPath: `/fake/run/${role}.sock`, startedAt: new Date(T0).toISOString() })}\n`,
        );
      },
      exit: (code, signal = null) => {
        if (child.exited !== undefined) return;
        child.exited = { code, signal };
        events.push({ kind: 'exit', role, pid, at: now(), detail: `${code}:${signal}` });
        order.push(`exit:${role}`);
        if (!child.behaviour.holdPipes) {
          stdout.end();
          stderr.end();
        }
        for (const listener of exitListeners) listener({ code, signal });
      },
      writeStdout: (line) => void stdout.write(`${line}\n`),
      writeStderr: (line) => void stderr.write(`${line}\n`),
    };
    const react = (reaction: TermReaction): void => {
      if (reaction === 'ignore') return;
      setImmediate(() => child.exit(reaction === 'exit0' ? 0 : 1));
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
          setImmediate(() => child.exit(null, signal));
          return;
        }
        if (signal === 'SIGTERM') react(child.behaviour.onTerm);
        else if (signal === 'SIGINT') react(child.behaviour.onInt);
        else if (signal === 'SIGKILL' && child.behaviour.onKill === 'die') setImmediate(() => child.exit(null, 'SIGKILL'));
      },
      killGroup: () => {
        child.groupKills += 1;
        events.push({ kind: 'killGroup', role, pid, at: now() });
        order.push(`SIGKILL-group:${role}`);
        if (child.exited !== undefined) return;
        if (everyoneDies || child.behaviour.onKill === 'die') setImmediate(() => child.exit(null, 'SIGKILL'));
      },
    };
    children.push(child);
    events.push({ kind: 'spawn', role, pid, at: now() });
    order.push(`spawn:${role}`);
    if (child.behaviour.autoReady) setImmediate(() => child.ready());
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
      for (const child of children) if (child.exited === undefined && (child.signals.length > 0 || child.groupKills > 0)) setImmediate(() => child.exit(null, 'SIGKILL'));
    },
  };
};

export const CHAT_CAPABILITIES = { contextWindow: 128000, maxOutputTokens: 4096 };

export const chatTarget = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  adapter: 'chat-completions',
  model: 'gpt-x',
  baseUrl: 'https://api.example.com/v1',
  capabilities: CHAT_CAPABILITIES,
  ...overrides,
});

export const validSettings = (overrides: { model?: string; sandbox?: 'seatbelt' | 'none'; apiKeyEnv?: string; permissions?: unknown } = {}): Record<string, unknown> => ({
  models: {
    targets: { remote: chatTarget({ model: overrides.model ?? 'gpt-x', ...(overrides.apiKeyEnv === undefined ? {} : { apiKeyEnv: overrides.apiKeyEnv }) }) },
    aliases: { default: 'remote' },
  },
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
    findHolders: async (marker) => {
      calls.findHolders.push(marker);
      record?.push('findHolders');
      return overrides.findHolders === undefined ? [] : overrides.findHolders(marker);
    },
    reapMarkerDirectory: async (options) => {
      calls.reapMarkerDirectory.push(options);
      record?.push('reapMarkerDirectory');
      return overrides.reapMarkerDirectory === undefined ? { reaped: 0, kept: 0 } : overrides.reapMarkerDirectory(options);
    },
    reapMarkedProcesses: async (options) => {
      calls.reapMarkedProcesses.push(options);
      record?.push('reapMarkedProcesses');
      if (overrides.reapMarkedProcesses !== undefined) return overrides.reapMarkedProcesses(options);
      fs.rmSync(options.marker, { force: true });
      return { removed: true };
    },
  };
  return { ports, calls };
};

export const pump = async (timers: FakeTimers, ms: number, stepMs = 50): Promise<void> => {
  let remaining = ms;
  await turns();
  while (remaining > 0) {
    const step = Math.min(stepMs, remaining);
    timers.advance(step);
    remaining -= step;
    await turns();
  }
};

export const pumpUntil = async (timers: FakeTimers, predicate: () => boolean, options: { stepMs?: number; maxMs?: number; description?: string } = {}): Promise<void> => {
  const stepMs = options.stepMs ?? 50;
  const maxMs = options.maxMs ?? 600_000;
  let elapsed = 0;
  await turns();
  while (!predicate()) {
    if (elapsed >= maxMs) throw new Error(`pumpUntil: ${options.description ?? 'condition'} not met after ${maxMs} fake ms`);
    timers.advance(stepMs);
    elapsed += stepMs;
    await turns();
  }
};

export const settledFlag = <T>(promise: Promise<T>): { settled(): boolean; value(): T | undefined } => {
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
  return { settled: () => done, value: () => result };
};

export type Harness = {
  readonly home: string;
  readonly paths: MomongaPaths;
  readonly clock: FakeClock;
  readonly timers: FakeTimers;
  readonly fake: FakeSpawn;
  readonly log: CapturedLog;
  readonly stdout: CapturedText;
  readonly markers: { ports: Required<MarkerPorts>; calls: MarkerCalls };
  readonly order: string[];
  readonly supervisor: SupervisorProcess;
  health(): SupervisorHealth;
  child(role: ChildRole): SupervisorHealth['children'][number];
  waitForState(role: ChildRole, state: string, maxMs?: number): Promise<void>;
};

export type HarnessOptions = {
  settings?: unknown;
  settingsText?: string;
  markerPorts?: MarkerPorts;
  overrides?: Partial<Omit<SupervisorOptions, 'spawn' | 'home' | 'version' | 'launcher' | 'clock' | 'timers' | 'logger' | 'stdout' | 'markerPorts'>> & {
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
  return { home, paths: momongaPaths(home) };
};

export const startHarness = async (context: CleanupContext, options: HarnessOptions = {}): Promise<Harness> => {
  const home = options.home ?? withTempDir(context, { asHome: true });
  const paths = momongaPaths(home);
  if (options.settingsText !== undefined) writeSettingsText(home, options.settingsText);
  else writeSettings(home, options.settings ?? validSettings());
  options.prepare?.(home, paths);
  const clock = createFakeClock(T0);
  const timers = createFakeTimers(clock);
  const order: string[] = options.order ?? [];
  const fake = createFakeSpawn({ clock, record: order, ...(options.behaviours === undefined ? {} : { behaviours: options.behaviours }) });
  const log = captureLog(clock);
  const stdout = captureText((chunk) => {
    order.push('ready');
    options.onStdout?.(chunk);
  });
  const markers = recordingMarkerPorts(options.markerPorts ?? {}, order);
  const supervisor = await startSupervisor({
    home,
    version: TEST_VERSION,
    launcher: options.overrides?.launcher ?? fakeLauncher,
    env: { PATH: '/usr/bin:/bin', HOME: home, LANG: 'C' },
    clock,
    timers,
    logger: log.logger,
    stdout,
    spawn: fake.port,
    markerPorts: markers.ports,
    random: () => 0.5,
    watchSettings: false,
    ...options.overrides,
  });
  registerCleanup(context, async () => {
    fake.dieOnAnySignal();
    const closing = settledFlag(supervisor.abort());
    let rounds = 0;
    while (!closing.settled() && rounds < 2000) {
      timers.advance(1000);
      await turns(5);
      rounds += 1;
    }
  });
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
    fake,
    log,
    stdout,
    markers,
    order,
    supervisor,
    health,
    child,
    waitForState: async (role, state, maxMs = 120_000) => {
      await pumpUntil(timers, () => child(role).state === state, { maxMs, description: `${role} ${state}` });
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
  const client = createUdsClient(socketPath, { headersTimeoutMs: 5000 });
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
    if (listener !== undefined) emitter.on('change', listener);
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

export const drive = async (timers: FakeTimers, done: () => boolean, options: { stepMs?: number; maxSteps?: number; description?: string } = {}): Promise<void> => {
  const stepMs = options.stepMs ?? 50;
  const maxSteps = options.maxSteps ?? 10_000;
  for (let step = 0; step < maxSteps && !done(); step += 1) {
    await waitFor(() => done() || timers.pending().length > 0, { description: options.description ?? 'next fake timer' });
    if (done()) return;
    timers.advance(stepMs);
    await turns(5);
  }
  if (!done()) throw new Error(`drive: ${options.description ?? 'condition'} not met after ${maxSteps} steps`);
};
