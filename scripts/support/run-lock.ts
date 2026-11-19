import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { bsdFileLock, createLockCapability, lockPathNameOf, sqliteFileLock } from '@momonga/foundation';
import { REAP_KILL_GRACE_MS } from '../../packages/foundation/src/process-contract.ts';
import type { HeldKernelLock, KernelLockMechanism, LockCapabilityProbe } from '@momonga/foundation';
import { treeCpuSeconds } from './cpu-budget.ts';

export type RunClass = 'heavy' | 'light';

export const RUN_LOCK_ENV = 'MOMONGA_RUN_LOCK';
export const RUN_LOCK_WAIT_ENV = 'MOMONGA_RUN_LOCK_WAIT_SECONDS';
export const RUN_LOCK_DEFAULT_WAIT_SECONDS = 3600;
export const RUN_LOCK_POLL_MS = 1000;
export const RUN_LOCK_EXIT = { usage: 64, refused: 71, waitedOut: 72, unusable: 73, interrupted: 130, terminated: 143, cpuBudget: 81, starterGone: 82 } as const;
export const LIGHT_HOLDER_STALL_MS = 10 * 60 * 1000;
export const LIGHT_STEPS = ['claimOwn', 'checkHeavy'] as const;
export const HEAVY_STEPS = ['claimHeavy', 'scanOne', 'decide'] as const;

export const NESTED_HEAVY_MESSAGE = 'run-lock: a heavy run cannot start inside a light run';
export const STOPPED_WHILE_WAITING_MESSAGE = 'run-lock: stopped while waiting; the command did not run';

export const runLockDirsOf = (stateDir: string): { dir: string; proofDir: string } => ({ dir: path.join(stateDir, 'run-lock'), proofDir: path.join(stateDir, 'run-lock-proof') });

const STOPPING_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

export type StoppingSignal = (typeof STOPPING_SIGNALS)[number];

export const untilStopped = async <T>(work: (signal: AbortSignal) => Promise<T>): Promise<{ result: T; stoppedBy: StoppingSignal | undefined }> => {
  const stopping = new AbortController();
  let stoppedBy: StoppingSignal | undefined;
  const stoppers = STOPPING_SIGNALS.map((signal) => {
    const stop = (): void => {
      stoppedBy ??= signal;
      stopping.abort();
    };
    process.on(signal, stop);
    return { signal, stop };
  });
  try {
    const result = await work(stopping.signal);
    return { result, stoppedBy };
  } finally {
    for (const { signal, stop } of stoppers) process.off(signal, stop);
  }
};

const WAIT_SOURCE_NAMES = { option: '--wait', env: RUN_LOCK_WAIT_ENV } as const;

export type WaitSource = keyof typeof WAIT_SOURCE_NAMES;

export const parseWaitSeconds = (text: string | undefined, source: WaitSource): number => {
  if (source === 'env' && (text === undefined || text === '')) return RUN_LOCK_DEFAULT_WAIT_SECONDS;
  if (text === undefined || !/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new Error(`run-lock: ${WAIT_SOURCE_NAMES[source]} must be a whole number of seconds, got "${text ?? ''}"`);
  }
  return Number(text);
};

export const parseBudgetSeconds = (text: string, source: string): number => {
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error(`run-lock: ${source} must be a whole number of CPU seconds above 0, got "${text}"`);
  return Number(text);
};

export const causeOf = (error: unknown): string => {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code;
  return error instanceof Error ? error.message : String(error);
};

export const unusableMessage = (subject: string, cause: string): string => `run-lock: cannot use ${subject}: ${cause}`;

export type HolderDescription = { readonly pid: number; readonly startedAt: string; readonly cwd: string; readonly command: string };

const DESCRIPTION_FORMAT = 'momonga-run-lock/1';
const COMMAND_MAX_CHARACTERS = 300;
const HEAVY_NAME = 'heavy';
const LIGHT_NAME = /^light\.[0-9a-f]{16}$/;
const WAITER_NAME = /^waiting\.(\d{16})\.(heavy|light)\.([0-9a-f]{16})$/;
const ARRIVAL_NAME = 'arrival';
const ARRIVAL_NEXT_FILE = 'arrival.next';
const ARRIVAL_DIGITS = 16;
const ARRIVAL_RETRY_MS = 10;
const ARRIVAL_BOUND_MS = 10_000;
const TOKEN = /^(heavy|light)\.([0-9a-f]{16})$/;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

const heavyPathOf = (dir: string): string => path.join(dir, HEAVY_NAME);
const lightPathOf = (dir: string, hex: string): string => path.join(dir, `light.${hex}`);
const waiterPathOf = (dir: string, arrival: number, runClass: RunClass, hex: string): string => path.join(dir, `waiting.${String(arrival).padStart(ARRIVAL_DIGITS, '0')}.${runClass}.${hex}`);
const infoPathOf = (lockPath: string): string => `${lockPath}.info`;

const describedBy = (parsed: unknown, token: string, runClass: RunClass): HolderDescription | undefined => {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const fields: Readonly<Record<string, unknown>> = { ...parsed };
  const { pid, startedAt, cwd, command } = fields;
  if (fields['format'] !== DESCRIPTION_FORMAT || fields['token'] !== token || fields['class'] !== runClass) return undefined;
  if (typeof pid !== 'number' || typeof startedAt !== 'string' || typeof cwd !== 'string' || typeof command !== 'string') return undefined;
  return { pid, startedAt, cwd, command };
};

const descriptionOfHeld = async (lockPath: string, runClass: RunClass, mechanism: KernelLockMechanism): Promise<HolderDescription | undefined> => {
  const token = await mechanism.readHolder(lockPath);
  if (token === undefined) return undefined;
  try {
    return describedBy(JSON.parse(await fs.promises.readFile(infoPathOf(lockPath), 'utf8')), token, runClass);
  } catch {
    return undefined;
  }
};

export const describeHolder = async (lockPath: string, runClass: RunClass, mechanism: KernelLockMechanism): Promise<HolderDescription | undefined> =>
  (await mechanism.isHeld(lockPath)) ? descriptionOfHeld(lockPath, runClass, mechanism) : undefined;

export const clauseOf = (runClass: RunClass, description: HolderDescription | undefined): string =>
  description === undefined ? `${runClass} (no description)` : `${runClass} pid ${description.pid} started ${description.startedAt} in ${description.cwd}: ${description.command}`;

const clauseOfHeld = async (lockPath: string, runClass: RunClass, mechanism: KernelLockMechanism): Promise<string> =>
  clauseOf(runClass, await descriptionOfHeld(lockPath, runClass, mechanism));

export type RunLockRequest = {
  runClass: RunClass;
  dir: string;
  proofDir: string;
  command: string;
  cwd: string;
  pid: number;
  env: Readonly<Record<string, string | undefined>>;
  waitSeconds: number;
  signal: AbortSignal;
  say: (line: string) => void;
  now?: () => Date;
  monotonic?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs?: number;
  mechanism?: KernelLockMechanism;
  capability?: Pick<LockCapabilityProbe, 'of'>;
  progressOf?: (pid: number) => Promise<number>;
  endHolder?: (pid: number, signal: HolderSignal) => void | Promise<void>;
};

export type HolderSignal = 'SIGTERM' | 'SIGKILL';

export type RunLockOutcome =
  | { kind: 'acquired'; token: string; mechanism: 'file-lock' | 'sqlite-lock'; release: () => Promise<void> }
  | { kind: 'inherited' }
  | { kind: 'refused'; message: string }
  | { kind: 'waited-out'; message: string }
  | { kind: 'aborted' }
  | { kind: 'unusable'; message: string };

class LockUnusableError extends Error {}

class SamplerFailure extends Error {}

const lockWork = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SamplerFailure) throw error;
    throw new LockUnusableError(causeOf(error));
  }
};

const measuredCapabilities = new Map<string, LockCapabilityProbe>();

const capabilityMeasuredIn = (proofDir: string): LockCapabilityProbe => {
  const known = measuredCapabilities.get(proofDir);
  if (known !== undefined) return known;
  const created = createLockCapability({ proofDir });
  measuredCapabilities.set(proofDir, created);
  return created;
};

const mechanismFor = async (request: RunLockRequest): Promise<KernelLockMechanism> => {
  await fs.promises.mkdir(request.dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if (request.mechanism !== undefined) return request.mechanism;
  await fs.promises.mkdir(request.proofDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const capability = await (request.capability ?? capabilityMeasuredIn(request.proofDir)).of(request.dir);
  if (capability === 'unmeasured') throw new Error(`the lock capability of ${request.dir} could not be measured`);
  return capability === 'proved' ? bsdFileLock : sqliteFileLock;
};

type Arrival = { seq: number; hex: string | undefined };

type AttemptContext = {
  readonly request: RunLockRequest;
  readonly mechanism: KernelLockMechanism;
  readonly now: () => Date;
  readonly arrival: Arrival;
};

type Holding = { readonly kind: 'holding'; readonly lock: HeldKernelLock; readonly lockPath: string; readonly hex: string };
type LightHolder = { readonly pid: number; readonly clause: string };
type Busy = { readonly kind: 'busy'; readonly clauses: readonly string[]; readonly lights: readonly LightHolder[] };
type Attempt = Holding | Busy;

const newTokenHex = (): string => randomBytes(8).toString('hex');

const claimNamed = async (mechanism: KernelLockMechanism, lockPath: string, hex: string): Promise<HeldKernelLock | undefined> => {
  const outcome = await mechanism.claim(lockPath);
  if (outcome.kind === 'held') return undefined;
  try {
    outcome.lock.writeHolder(hex);
  } catch (error) {
    outcome.lock.dispose();
    throw error;
  }
  return outcome.lock;
};

const writeDescription = async ({ request }: AttemptContext, lockPath: string, hex: string, startedAt: string): Promise<void> => {
  const temporary = path.join(path.dirname(lockPath), `.${path.basename(lockPath)}.info.${request.pid}.tmp`);
  const description = {
    format: DESCRIPTION_FORMAT,
    token: hex,
    class: request.runClass,
    pid: request.pid,
    startedAt,
    cwd: request.cwd,
    command: request.command.slice(0, COMMAND_MAX_CHARACTERS),
  };
  await fs.promises.writeFile(temporary, JSON.stringify(description), { mode: PRIVATE_FILE_MODE });
  await fs.promises.rename(temporary, infoPathOf(lockPath));
};

const disposedOnFailure = async (lock: HeldKernelLock, work: () => Promise<Attempt>): Promise<Attempt> => {
  try {
    return await work();
  } catch (error) {
    lock.dispose();
    throw error;
  }
};

type Claimed = { readonly lock: HeldKernelLock; readonly lockPath: string; readonly hex: string; readonly startedAt: string };

const describedHolding = async (context: AttemptContext, { lock, lockPath, hex, startedAt }: Claimed): Promise<Holding> => {
  await writeDescription(context, lockPath, hex, startedAt);
  return { kind: 'holding', lock, lockPath, hex };
};

const claimOwn = async ({ request, mechanism, now }: AttemptContext): Promise<Claimed | Busy> => {
  const hex = newTokenHex();
  const lockPath = lightPathOf(request.dir, hex);
  const lock = await claimNamed(mechanism, lockPath, hex);
  if (lock === undefined) return { kind: 'busy', clauses: [await clauseOfHeld(lockPath, 'light', mechanism)], lights: [] };
  return { lock, lockPath, hex, startedAt: now().toISOString() };
};

const liveHolderClause = async (mechanism: KernelLockMechanism, lockPath: string, describe: () => Promise<string>): Promise<string | undefined> => {
  if (await mechanism.isHeld(lockPath)) return describe();
  const leftover = await mechanism.claim(lockPath);
  if (leftover.kind === 'held') return describe();
  leftover.lock.dispose();
  await fs.promises.rm(infoPathOf(lockPath), { force: true });
  return undefined;
};


const lockUnitsNamed = async ({ request, mechanism }: AttemptContext, pattern: RegExp): Promise<string[]> => {
  const units = (await fs.promises.readdir(request.dir)).map((name) => lockPathNameOf(mechanism, name)).filter((name) => pattern.test(name));
  return [...new Set(units)].sort();
};

const earlierWaiters = async (context: AttemptContext, classes: readonly RunClass[]): Promise<string[]> => {
  const { request, mechanism, arrival } = context;
  const clauses: string[] = [];
  for (const name of await lockUnitsNamed(context, WAITER_NAME)) {
    const [, seq, waiterClass, hex] = WAITER_NAME.exec(name) ?? [];
    if (seq === undefined || waiterClass === undefined || hex === arrival.hex) continue;
    const runClass: RunClass = waiterClass === 'heavy' ? 'heavy' : 'light';
    const waiterPath = path.join(request.dir, name);
    const clause = await liveHolderClause(mechanism, waiterPath, async () => `waiting ${await clauseOfHeld(waiterPath, runClass, mechanism)}`);
    if (clause !== undefined && Number(seq) < arrival.seq && classes.includes(runClass)) clauses.push(clause);
  }
  return clauses;
};

const busyWith = (clauses: readonly string[]): Busy | undefined => (clauses.length === 0 ? undefined : { kind: 'busy', clauses, lights: [] });

const checkHeavy = async (context: AttemptContext): Promise<Busy | undefined> => {
  const { request, mechanism } = context;
  const heavyPath = heavyPathOf(request.dir);
  if (await mechanism.isHeld(heavyPath)) return { kind: 'busy', clauses: [await clauseOfHeld(heavyPath, 'heavy', mechanism)], lights: [] };
  return busyWith(await earlierWaiters(context, ['heavy']));
};

const lightAttempt = async (context: AttemptContext): Promise<Attempt> => {
  const ahead = busyWith(await earlierWaiters(context, ['heavy']));
  if (ahead !== undefined) return ahead;
  const own = await claimOwn(context);
  if ('kind' in own) return own;
  return disposedOnFailure(own.lock, async () => {
    const heavy = await checkHeavy(context);
    if (heavy === undefined) return describedHolding(context, own);
    own.lock.dispose();
    return heavy;
  });
};

const claimHeavy = async ({ request, mechanism, now }: AttemptContext): Promise<Claimed | Busy> => {
  const hex = newTokenHex();
  const lockPath = heavyPathOf(request.dir);
  const lock = await claimNamed(mechanism, lockPath, hex);
  if (lock === undefined) return { kind: 'busy', clauses: [await clauseOfHeld(lockPath, 'heavy', mechanism)], lights: [] };
  return { lock, lockPath, hex, startedAt: now().toISOString() };
};

type ScannedLight = { readonly clause: string; readonly pid: number | undefined };

const scanOne = async ({ mechanism }: AttemptContext, lightPath: string): Promise<ScannedLight | undefined> => {
  let pid: number | undefined;
  const clause = await liveHolderClause(mechanism, lightPath, async () => {
    const description = await descriptionOfHeld(lightPath, 'light', mechanism);
    pid = description?.pid;
    return clauseOf('light', description);
  });
  return clause === undefined ? undefined : { clause, pid };
};

const decide = async (context: AttemptContext, heavy: Claimed, lightHolders: readonly ScannedLight[]): Promise<Attempt> => {
  if (lightHolders.length === 0) return describedHolding(context, heavy);
  heavy.lock.dispose();
  return {
    kind: 'busy',
    clauses: lightHolders.map((holder) => holder.clause),
    lights: lightHolders.flatMap(({ clause, pid }) => (pid === undefined ? [] : [{ pid, clause }])),
  };
};

const heavyAttempt = async (context: AttemptContext): Promise<Attempt> => {
  const ahead = busyWith(await earlierWaiters(context, ['heavy', 'light']));
  if (ahead !== undefined) return ahead;
  const heavy = await claimHeavy(context);
  if ('kind' in heavy) return heavy;
  return disposedOnFailure(heavy.lock, async () => {
    const lightNames = await lockUnitsNamed(context, LIGHT_NAME);
    const lightHolders: ScannedLight[] = [];
    for (const name of lightNames) {
      const holder = await scanOne(context, path.join(context.request.dir, name));
      if (holder !== undefined) lightHolders.push(holder);
    }
    return decide(context, heavy, lightHolders);
  });
};

const attemptOf = (context: AttemptContext): Promise<Attempt> => lockWork(() => (context.request.runClass === 'heavy' ? heavyAttempt(context) : lightAttempt(context)));

const liveTokenClass = async ({ request, mechanism }: AttemptContext): Promise<RunClass | undefined> => {
  const [, tokenClass, hex] = TOKEN.exec(request.env[RUN_LOCK_ENV] ?? '') ?? [];
  if (hex === undefined) return undefined;
  if (tokenClass === 'heavy') {
    const heavyPath = heavyPathOf(request.dir);
    return (await mechanism.isHeld(heavyPath)) && (await mechanism.readHolder(heavyPath)) === hex ? 'heavy' : undefined;
  }
  return (await mechanism.isHeld(lightPathOf(request.dir, hex))) ? 'light' : undefined;
};

const acquiredFrom = ({ request, mechanism }: AttemptContext, holding: Holding): RunLockOutcome => {
  let released = false;
  return {
    kind: 'acquired',
    token: `${request.runClass}.${holding.hex}`,
    mechanism: mechanism.name,
    release: async () => {
      if (released) return;
      released = true;
      try {
        await fs.promises.rm(infoPathOf(holding.lockPath), { force: true });
      } finally {
        holding.lock.dispose();
      }
    },
  };
};

type Waiter = { readonly release: () => Promise<void> };

const withArrivalUnit = async <T>(context: AttemptContext, work: () => Promise<T>): Promise<T> => {
  const arrivalPath = path.join(context.request.dir, ARRIVAL_NAME);
  const started = performance.now();
  for (;;) {
    const outcome = await context.mechanism.claim(arrivalPath);
    if (outcome.kind === 'claimed') {
      try {
        return await work();
      } finally {
        outcome.lock.dispose();
      }
    }
    if (performance.now() - started >= ARRIVAL_BOUND_MS) throw new Error(`the arrival unit ${arrivalPath} stayed held for ${ARRIVAL_BOUND_MS / 1000} s`);
    await delay(ARRIVAL_RETRY_MS);
  }
};

const takeArrival = (context: AttemptContext): Promise<number> =>
  withArrivalUnit(context, async () => {
    const nextPath = path.join(context.request.dir, ARRIVAL_NEXT_FILE);
    const text = await fs.promises.readFile(nextPath, 'utf8').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '1';
      throw error;
    });
    const arrival = Number(text);
    if (!Number.isSafeInteger(arrival) || arrival < 1) throw new Error(`${nextPath} holds no arrival number: "${text}"`);
    const temporary = `${nextPath}.${context.request.pid}.tmp`;
    await fs.promises.writeFile(temporary, String(arrival + 1), { mode: PRIVATE_FILE_MODE });
    await fs.promises.rename(temporary, nextPath);
    return arrival;
  });

const recordWaiter = async (context: AttemptContext): Promise<Waiter> => {
  const seq = await takeArrival(context);
  const hex = newTokenHex();
  const waiterPath = waiterPathOf(context.request.dir, seq, context.request.runClass, hex);
  const lock = await claimNamed(context.mechanism, waiterPath, hex);
  if (lock === undefined) throw new Error(`the waiter lock ${waiterPath} is held by another run`);
  try {
    await writeDescription(context, waiterPath, hex, context.now().toISOString());
  } catch (error) {
    lock.dispose();
    throw error;
  }
  context.arrival.seq = seq;
  context.arrival.hex = hex;
  return {
    release: async () => {
      try {
        await fs.promises.rm(infoPathOf(waiterPath), { force: true });
      } finally {
        lock.dispose();
      }
    },
  };
};

const defaultSleep = async (ms: number, signal: AbortSignal): Promise<void> => {
  await delay(ms, undefined, { signal });
};

const acquireOrWait = async (request: RunLockRequest): Promise<RunLockOutcome> => {
  const { runClass, waitSeconds, signal, say } = request;
  const context: AttemptContext = { request, mechanism: await lockWork(() => mechanismFor(request)), now: request.now ?? ((): Date => new Date()), arrival: { seq: Number.POSITIVE_INFINITY, hex: undefined } };

  const inherited = await lockWork(() => liveTokenClass(context));
  if (inherited === 'light' && runClass === 'heavy') return { kind: 'refused', message: NESTED_HEAVY_MESSAGE };
  if (inherited !== undefined) return { kind: 'inherited' };
  if (signal.aborted) return { kind: 'aborted' };

  const first = await attemptOf(context);
  if (first.kind === 'holding') return acquiredFrom(context, first);
  if (waitSeconds === 0) {
    return { kind: 'refused', message: `run-lock: ${runClass} run refused: held by ${first.clauses.join('; ')}. To wait, pass --wait <seconds> or set ${RUN_LOCK_WAIT_ENV}.` };
  }

  say(`run-lock: ${runClass} run waits up to ${waitSeconds} s for ${first.clauses.join('; ')}`);
  const waiter = await lockWork(() => recordWaiter(context));
  try {
    return await waitForLock(context, first);
  } finally {
    await waiter.release();
  }
};

const endBySignal = (pid: number, signal: HolderSignal): void => {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
};

type Progress = { readonly cpuSeconds: number; readonly sinceMs: number; readonly termAtMs: number | undefined };

const sampled = async (progressOf: (pid: number) => Promise<number>, pid: number, clause: string): Promise<number> => {
  try {
    return await progressOf(pid);
  } catch (error) {
    throw new SamplerFailure(`run-lock: cannot read the CPU time of the processes of ${clause}: ${causeOf(error)}`);
  }
};

const stalledLightWatch = (request: RunLockRequest, monotonic: () => number): ((lights: readonly LightHolder[]) => Promise<void>) => {
  const progressOf = request.progressOf ?? treeCpuSeconds;
  const endHolder = request.endHolder ?? endBySignal;
  const seen = new Map<number, Progress>();
  return async (lights) => {
    for (const { pid, clause } of lights) {
      const cpuSeconds = await sampled(progressOf, pid, clause);
      const nowMs = monotonic();
      const last = seen.get(pid);
      if (last === undefined || cpuSeconds > last.cpuSeconds) {
        seen.set(pid, { cpuSeconds, sinceMs: nowMs, termAtMs: undefined });
      } else if (last.termAtMs !== undefined) {
        if (nowMs - last.termAtMs < REAP_KILL_GRACE_MS) continue;
        request.say(`run-lock: ${request.runClass} run kills ${clause}: it outlived SIGTERM by ${Math.floor((nowMs - last.termAtMs) / 1000)} s`);
        seen.delete(pid);
        await endHolder(pid, 'SIGKILL');
      } else if (nowMs - last.sinceMs >= LIGHT_HOLDER_STALL_MS) {
        request.say(`run-lock: ${request.runClass} run ends ${clause}: its processes used no CPU time for ${Math.floor((nowMs - last.sinceMs) / 1000)} s`);
        seen.set(pid, { ...last, termAtMs: nowMs });
        await endHolder(pid, 'SIGTERM');
      }
    }
  };
};

const waitForLock = async (context: AttemptContext, first: Busy): Promise<RunLockOutcome> => {
  const { request } = context;
  const { runClass, waitSeconds, signal, say } = request;
  const monotonic = request.monotonic ?? ((): number => performance.now());
  const sleep = request.sleep ?? defaultSleep;
  const pollMs = request.pollMs ?? RUN_LOCK_POLL_MS;
  const waitStart = monotonic();
  const limitMs = waitSeconds * 1000;
  const watchLights = stalledLightWatch(request, monotonic);
  let holders = first.clauses;
  await lockWork(() => watchLights(first.lights));
  for (;;) {
    const remainingMs = limitMs - (monotonic() - waitStart);
    if (remainingMs <= 0) return { kind: 'waited-out', message: `run-lock: ${runClass} run gave up after ${waitSeconds} s: still held by ${holders.join('; ')}` };
    try {
      await sleep(Math.min(pollMs, remainingMs), signal);
    } catch (error) {
      if (signal.aborted) return { kind: 'aborted' };
      throw error;
    }
    if (signal.aborted) return { kind: 'aborted' };
    const next = await attemptOf(context);
    if (next.kind === 'holding') {
      say(`run-lock: ${runClass} run starts after waiting ${Math.floor((monotonic() - waitStart) / 1000)} s`);
      return acquiredFrom(context, next);
    }
    holders = next.clauses;
    await lockWork(() => watchLights(next.lights));
  }
};

export const acquireRunLock = async (request: RunLockRequest): Promise<RunLockOutcome> => {
  try {
    return await acquireOrWait(request);
  } catch (error) {
    if (error instanceof LockUnusableError) return { kind: 'unusable', message: unusableMessage(request.dir, error.message) };
    if (error instanceof SamplerFailure) return { kind: 'unusable', message: error.message };
    throw error;
  }
};
