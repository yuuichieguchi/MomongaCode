import path from 'node:path';
import { readUserStopValuesOrDefault } from '@momonga/config';
import {
  ABANDON_REASON_TEXTS,
  CurrentGenerationUnreadableError,
  GenerationPrepareError,
  HOST_READ_BOUND_MS,
  LIFELINE_FD,
  STARTUP_TIMEOUT_MS,
  STOP_WAIT_WHEN_UNKNOWN_MS,
  beginGenerationStart,
  daemonStopBoundMs,
  fixedSocket,
  generationLayout,
  hostKernelLock,
  listGenerations,
  lockReadsHeld,
  nodeFileSystem,
  operationLimit,
  orderVersions,
  probeGenerationLocks,
  readCurrentGeneration,
  readStartRecord,
  resolveGenerationFor,
  starterOutcome,
  stopWaitBoundMs as largestStopBoundMs,
} from '@momonga/foundation';
import type { AbandonReason, CurrentGeneration, GenerationRef, HeldStart, KernelLockMechanism, MomongaPaths, StartTrigger, StopValues } from '@momonga/foundation';
import { FIDELITY_FOLD_VERSION } from '@momonga/protocol';
import type { SupervisorHealth } from '@momonga/protocol';
import { createSupervisorClient } from '../client/supervisor-client.ts';
import type { SupervisorClient } from '../client/supervisor-client.ts';
import { DAEMON_POLL_INTERVAL_MS } from '../constants.ts';
import { PollTimeout, pollUntil } from '../poll.ts';
import type { CliPorts, DetachedExit } from '../ports.ts';
import { superviseInvocation } from './launcher.ts';
import type { StopNotice } from './stop-notice.ts';

export class DaemonStartError extends Error {
  readonly logFile: string;

  constructor(message: string, logFile: string, options: { pointsAtLog: boolean } = { pointsAtLog: true }) {
    super(options.pointsAtLog ? `${message}; see ${logFile}` : message);
    this.name = 'DaemonStartError';
    this.logFile = logFile;
  }
}

export type DaemonPorts = Pick<CliPorts, 'version' | 'env' | 'home' | 'clock' | 'self' | 'spawnDetached'>;

export type DaemonConnection = { health: SupervisorHealth; clientIsOlder: boolean };

const UNREACHABLE_CODES: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ENOENT']);

const errnoCodeOf = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
};

export const probeSupervisor = async (client: SupervisorClient): Promise<SupervisorHealth | undefined> => {
  try {
    return await client.health();
  } catch (error) {
    const code = errnoCodeOf(error);
    if (code !== undefined && UNREACHABLE_CODES.has(code)) return undefined;
    throw error;
  }
};

export const healthAt = async (socketPath: string): Promise<SupervisorHealth | undefined> => {
  const client = createSupervisorClient({ resolveSocket: fixedSocket(socketPath) });
  try {
    return await probeSupervisor(client);
  } finally {
    await client.close();
  }
};

export type DaemonBounds = { readyMs: number; stopMs: number };

export const daemonReadyBoundMs = async (): Promise<number> => STARTUP_TIMEOUT_MS;

export { STOP_WAIT_WHEN_UNKNOWN_MS };

export const stopWaitBoundMs = (healths: readonly SupervisorHealth[]): number => largestStopBoundMs(healths.map((health) => health.stopBoundMs));

export type { StopNotice };

const NO_NOTICE_CHANNEL: StopNotice = (message) => {
  throw new Error(`no notice channel was given for this daemon stop: ${message}`);
};

const STOP_VALUES_READ = 'the read of the stop values from the user settings';

const readStopValues = async (ports: Pick<DaemonPorts, 'home'>, onNotice: StopNotice): Promise<StopValues> => {
  const limit = operationLimit(new AbortController().signal, HOST_READ_BOUND_MS, STOP_VALUES_READ);
  try {
    return await readUserStopValuesOrDefault({ home: ports.home, signal: limit.signal, onNotice });
  } finally {
    limit.dispose();
  }
};

const homeOf = (paths: MomongaPaths): string => path.dirname(paths.root);

const supervisorSocketOf = (paths: MomongaPaths, generation: number): string => generationLayout(homeOf(paths), generation).sockets.supervisor;

const supervisorLockOf = (paths: MomongaPaths, generation: number): string => generationLayout(homeOf(paths), generation).locks.supervisor;

const heldFailure = (health: SupervisorHealth): string | undefined => {
  const held = health.children.find((child) => child.state === 'held-config');
  return held === undefined ? undefined : `${held.role} is held by its configuration: ${held.heldReason ?? 'no reason reported'}`;
};

const STOP_WAIT_DESCRIPTION = 'the daemon to stop';

const exitDescription = (exit: DetachedExit): string => `code ${exit.code}, signal ${exit.signal}`;

export const waitForGenerationsGone = async (
  ports: Pick<DaemonPorts, 'clock'>,
  paths: MomongaPaths,
  generations: readonly number[],
  stopMs: number,
  options: { signal?: AbortSignal; lock?: KernelLockMechanism } = {},
): Promise<void> => {
  const lock = options.lock ?? hostKernelLock();
  await pollUntil(
    ports.clock,
    async () => {
      for (const generation of generations) {
        if (await lockReadsHeld(supervisorLockOf(paths, generation), { lock })) return undefined;
      }
      return true;
    },
    { boundMs: stopMs, intervalMs: DAEMON_POLL_INTERVAL_MS, description: STOP_WAIT_DESCRIPTION, ...(options.signal === undefined ? {} : { signal: options.signal }) },
  );
};

export const liveGenerationsUnderLock = async (ports: Pick<DaemonPorts, 'clock'>, paths: MomongaPaths, lock: KernelLockMechanism, boundMs: number): Promise<number[]> =>
  pollUntil(
    ports.clock,
    async () => {
      const claim = await lock.claim(paths.generationLock);
      if (claim.kind === 'held') return undefined;
      try {
        return (await listGenerations(paths, { lock })).filter((listed) => listed.supervisorHeld).map((listed) => listed.generation);
      } finally {
        claim.lock.release();
      }
    },
    { boundMs, intervalMs: DAEMON_POLL_INTERVAL_MS, description: 'the generation lock to list the running daemons' },
  );

export type InterruptedWork = { steps: number; jobs: number };

export class DaemonStopTimeout extends PollTimeout {
  readonly remaining: readonly SupervisorHealth[];

  constructor(remaining: readonly SupervisorHealth[], boundMs: number) {
    super(STOP_WAIT_DESCRIPTION, boundMs);
    this.name = 'DaemonStopTimeout';
    this.message = remaining.map((health) => `the daemon (v${health.version}, pid ${health.pid}) did not stop within ${boundMs} ms`).join('; ');
    this.remaining = remaining;
  }
}

type StopFailure = { generation: number; failure: string };

type StopCandidate = { generation: number; health: SupervisorHealth };

type StopAsked = StopCandidate & { boundMs: number };

const stopFailure = (generation: number, error: unknown): StopFailure => ({
  generation,
  failure: `the daemon of generation ${generation} could not be asked to stop: ${error instanceof Error ? error.message : String(error)}`,
});

const stopCandidate = async (paths: MomongaPaths, generation: number): Promise<StopCandidate | StopFailure | undefined> => {
  try {
    const health = await healthAt(supervisorSocketOf(paths, generation));
    return health === undefined ? undefined : { generation, health };
  } catch (error) {
    return stopFailure(generation, error);
  }
};

const requestStop = async (paths: MomongaPaths, candidate: StopCandidate, values: () => Promise<StopValues>): Promise<StopAsked | StopFailure> => {
  if (candidate.health.phase === 'draining') return { ...candidate, boundMs: stopWaitBoundMs([candidate.health]) };
  const client = createSupervisorClient({ resolveSocket: fixedSocket(supervisorSocketOf(paths, candidate.generation)) });
  try {
    const stopValues = await values();
    await client.shutdown(stopValues);
    return { ...candidate, boundMs: daemonStopBoundMs(stopValues) };
  } catch (error) {
    return stopFailure(candidate.generation, error);
  } finally {
    await client.close();
  }
};

const sumOf = (counts: readonly (number | undefined)[]): number => counts.reduce<number>((sum, count) => (count === undefined ? sum : sum + count), 0);

export const stopDaemon = async (
  ports: DaemonPorts,
  paths: MomongaPaths,
  bounds?: DaemonBounds,
  onNotice: StopNotice = NO_NOTICE_CHANNEL,
  lock: KernelLockMechanism = hostKernelLock(),
  onInterrupting?: (work: InterruptedWork) => void,
): Promise<{ stopped: boolean }> => {
  const snapshot = await liveGenerationsUnderLock(ports, paths, lock, bounds?.stopMs ?? STOP_WAIT_WHEN_UNKNOWN_MS);
  const probed = (await Promise.all(snapshot.map((generation) => stopCandidate(paths, generation)))).filter((entry) => entry !== undefined);
  const candidates = probed.filter((entry) => 'health' in entry);
  onInterrupting?.({ steps: sumOf(candidates.map((candidate) => candidate.health.steps)), jobs: sumOf(candidates.map((candidate) => candidate.health.jobs)) });
  let stopValues: Promise<StopValues> | undefined;
  const values = (): Promise<StopValues> => (stopValues ??= readStopValues(ports, onNotice));
  const requests = await Promise.all(candidates.map((candidate) => requestStop(paths, candidate, values)));
  const asked = requests.filter((request) => 'boundMs' in request);
  const failures = [...probed, ...requests].flatMap((entry) => ('failure' in entry ? [entry.failure] : []));
  if (asked.length > 0) {
    const stopMs = bounds?.stopMs ?? largestStopBoundMs(asked.map((request) => request.boundMs));
    try {
      await waitForGenerationsGone(
        ports,
        paths,
        asked.map((request) => request.generation),
        stopMs,
        { lock },
      );
    } catch (error) {
      if (!(error instanceof PollTimeout)) throw error;
      const remaining: SupervisorHealth[] = [];
      for (const request of asked) {
        if (await lockReadsHeld(supervisorLockOf(paths, request.generation), { lock })) remaining.push(request.health);
      }
      if (remaining.length > 0) throw new DaemonStopTimeout(remaining, stopMs);
    }
  }
  if (failures.length > 0) throw new Error(failures.join('; '));
  return { stopped: asked.length > 0 };
};

type SpawnOutcome = { exit: DetachedExit } | { error: unknown };

type OwnStart = {
  ref: GenerationRef;
  spawned: (() => SpawnOutcome | undefined) | undefined;
  starting: HeldStart | undefined;
  sawSupervisor: boolean;
};

const unorderedMessage = (ports: DaemonPorts, health: SupervisorHealth): string =>
  `the daemon (pid ${health.pid}) runs version ${health.version}, not ${ports.version}, and it may be in use by newer clients; update or restart this CLI`;

export const belowFloorMessage = (clientVersion: string, floor: string): string =>
  `momonga v${clientVersion} is older than the last daemon version v${floor}; update this program, then run it again.`;

export const reopenSessionMessage = (daemonVersion: string): string => `momonga was updated to v${daemonVersion}; reopen this session.`;

export const olderCommandMessage = (daemonVersion: string): string =>
  `momonga was updated to v${daemonVersion} while this command was running; run it again. Your tasks are not affected.`;

const SUPERVISOR_STOPPED_UNPROMOTED = 'its supervisor stopped before it was promoted';

const abandonedText = (reason: AbandonReason): string => `its start was abandoned before it began: ${ABANDON_REASON_TEXTS[reason]}`;

const notStartedMessage = (version: string, reason: string, serving: GenerationRef | undefined): string =>
  `The new daemon (v${version}) did not start (${reason}).${serving === undefined ? '' : ` v${serving.version} keeps running.`}`;

const directoryGone = async (directory: string): Promise<boolean> => {
  try {
    await nodeFileSystem.lstat(directory);
    return false;
  } catch (error) {
    if (errnoCodeOf(error) === 'ENOENT') return true;
    throw error;
  }
};

const abandonReasonOf = async (paths: MomongaPaths, own: OwnStart, lock: KernelLockMechanism): Promise<string> => {
  const generation = own.ref.generation;
  if (await directoryGone(generationLayout(homeOf(paths), generation).dir)) return abandonedText('directory-missing');
  if (own.sawSupervisor) return SUPERVISOR_STOPPED_UNPROMOTED;
  const record = await readStartRecord(paths, generation);
  if (record.kind === 'missing') return abandonedText('record-missing');
  if (record.kind === 'unreadable') return abandonedText('record-unreadable');
  if (own.spawned === undefined) return SUPERVISOR_STOPPED_UNPROMOTED;
  if (await lockReadsHeld(supervisorLockOf(paths, generation), { lock })) return abandonedText('lock-held');
  return abandonedText('version-differs');
};

const startFailure = async (paths: MomongaPaths, own: OwnStart, current: CurrentGeneration | undefined, currentHeld: boolean, lock: KernelLockMechanism): Promise<Error> => {
  const outcome = own.spawned?.();
  if (outcome !== undefined && 'error' in outcome) return outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
  if (outcome !== undefined && outcome.exit.code !== 0) return new DaemonStartError(`the supervisor exited (${exitDescription(outcome.exit)}) before it was ready`, paths.logFiles.supervisor);
  if (current !== undefined && current.generation > own.ref.generation && currentHeld) {
    return new DaemonStartError(
      `generation ${own.ref.generation} was replaced by an older version (v${current.version}) before it started; no daemon of v${own.ref.version} is running`,
      paths.logFiles.supervisor,
    );
  }
  const serving = current !== undefined && currentHeld ? { generation: current.generation, version: current.version } : undefined;
  return new DaemonStartError(notStartedMessage(own.ref.version, await abandonReasonOf(paths, own, lock), serving), paths.logFiles.supervisor);
};

export type EnsureDaemonOptions = {
  bounds?: DaemonBounds;
  signal?: AbortSignal;
  lifeline?: boolean;
  trigger?: Extract<StartTrigger, 'client' | 'restart'>;
  lock?: KernelLockMechanism;
};

const spawnSupervisor = (ports: DaemonPorts, generation: number, lifeline: boolean): (() => SpawnOutcome | undefined) => {
  const invocation = superviseInvocation(ports.self, ports.home, generation, lifeline ? LIFELINE_FD : undefined);
  const child = ports.spawnDetached({ command: invocation.command, args: invocation.args, env: ports.env, cwd: ports.home, ...(lifeline ? { lifeline } : {}) });
  let outcome: SpawnOutcome | undefined;
  void child.exit.then(
    (exit) => {
      outcome = { exit };
    },
    (error: unknown) => {
      outcome = { error };
    },
  );
  return () => outcome;
};

const wrapStartError = (paths: MomongaPaths, error: unknown): unknown => {
  if (error instanceof GenerationPrepareError) return new DaemonStartError(error.message, paths.logFiles.supervisor);
  if (error instanceof CurrentGenerationUnreadableError) return new DaemonStartError(error.message, paths.logFiles.supervisor, { pointsAtLog: false });
  return error;
};

export const ensureDaemon = async (ports: DaemonPorts, paths: MomongaPaths, options: EnsureDaemonOptions = {}): Promise<DaemonConnection> => {
  const { signal } = options;
  signal?.throwIfAborted();
  const readyMs = options.bounds?.readyMs ?? (await daemonReadyBoundMs());
  const lock = options.lock ?? hostKernelLock();
  const start: { own: OwnStart | undefined } = { own: undefined };
  let draining: number | undefined;

  const decide = async (): Promise<DaemonConnection | undefined> => {
    const outcome = await beginGenerationStart(paths, {
      version: ports.version,
      foldVersion: FIDELITY_FOLD_VERSION,
      lock,
      trigger: options.trigger ?? 'client',
      ...(draining === undefined ? {} : { draining }),
    });
    switch (outcome.kind) {
      case 'busy':
        return undefined;
      case 'serving': {
        const health = await healthAt(supervisorSocketOf(paths, outcome.generation));
        if (health === undefined) return undefined;
        if (health.phase === 'draining') {
          draining = outcome.generation;
          return undefined;
        }
        return { health, clientIsOlder: false };
      }
      case 'older': {
        const current = await readCurrentGeneration(paths);
        const health = current === undefined ? undefined : await healthAt(current.sockets.supervisor);
        if (current === undefined || health === undefined) return undefined;
        if (health.phase === 'draining') {
          draining = current.generation;
          return undefined;
        }
        if (orderVersions(ports.version, health.version) !== 'older') throw new DaemonStartError(unorderedMessage(ports, health), paths.logFiles.supervisor);
        return { health, clientIsOlder: true };
      }
      case 'below-floor':
        throw new DaemonStartError(belowFloorMessage(ports.version, outcome.floor), paths.logFiles.supervisor, { pointsAtLog: false });
      case 'joined':
        start.own = { ref: { generation: outcome.generation, version: ports.version }, spawned: undefined, starting: undefined, sawSupervisor: false };
        return undefined;
      case 'allocated':
        start.own = { ref: { generation: outcome.generation, version: ports.version }, spawned: undefined, starting: outcome.starting, sawSupervisor: false };
        start.own.spawned = spawnSupervisor(ports, outcome.generation, options.lifeline === true);
        return undefined;
    }
  };

  const watch = async (started: OwnStart): Promise<DaemonConnection | undefined> => {
    const current = await readCurrentGeneration(paths);
    const covering = current !== undefined && current.generation >= started.ref.generation;
    const currentHealth = current !== undefined && covering ? await healthAt(current.sockets.supervisor) : undefined;
    const currentHeld = current !== undefined && (await lockReadsHeld(supervisorLockOf(paths, current.generation), { lock }));
    const ownLocks = await probeGenerationLocks(paths, started.ref.generation, { lock });
    if (ownLocks.supervisorHeld) started.sawSupervisor = true;
    const spawnOutcome = started.spawned?.();
    const ownSupervisorGone = started.spawned === undefined ? !ownLocks.supervisorHeld && !ownLocks.startingHeld : spawnOutcome !== undefined;
    const outcome = starterOutcome({
      own: started.ref,
      ...(current === undefined ? {} : { current: { generation: current.generation, version: current.version } }),
      currentHeld: currentHeld && currentHealth !== undefined,
      currentDraining: currentHealth?.phase === 'draining',
      ownSupervisorGone,
      ownDirectoryGone: await directoryGone(generationLayout(homeOf(paths), started.ref.generation).dir),
    });
    if (outcome === 'success' && currentHealth !== undefined) return { health: currentHealth, clientIsOlder: orderVersions(ports.version, currentHealth.version) === 'older' };
    if (outcome === 'failed') throw await startFailure(paths, started, current, currentHeld, lock);
    const ownHealth = current?.generation === started.ref.generation ? currentHealth : await healthAt(supervisorSocketOf(paths, started.ref.generation));
    if (ownHealth !== undefined) {
      started.sawSupervisor = true;
      const held = heldFailure(ownHealth);
      if (held !== undefined) throw new DaemonStartError(held, paths.logFiles.supervisor);
    }
    return undefined;
  };

  try {
    const step = async (): Promise<DaemonConnection | undefined> => {
      const decided = start.own === undefined ? await decide() : undefined;
      if (decided !== undefined || start.own === undefined) return decided;
      return watch(start.own);
    };
    return await pollUntil(ports.clock, step, {
      boundMs: readyMs,
      intervalMs: DAEMON_POLL_INTERVAL_MS,
      description: 'the daemon to become ready',
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    throw wrapStartError(paths, error);
  } finally {
    start.own?.starting?.release();
  }
};

const notPointingAtLog = { pointsAtLog: false };

export const ensureCurrentDaemon = async (ports: DaemonPorts, paths: MomongaPaths, options: EnsureDaemonOptions = {}): Promise<SupervisorHealth> => {
  const connection = await ensureDaemon(ports, paths, options);
  if (connection.clientIsOlder) throw new DaemonStartError(olderCommandMessage(connection.health.version), paths.logFiles.supervisor, notPointingAtLog);
  return connection.health;
};

export type NewerListener = (version: string) => Promise<void>;

export type EnsureSessionOptions = EnsureDaemonOptions & { onNewer?: NewerListener };

export const ensureSessionDaemon = async (ports: DaemonPorts, paths: MomongaPaths, options: EnsureSessionOptions = {}): Promise<void> => {
  const { onNewer, ...daemonOptions } = options;
  const connection = await ensureDaemon(ports, paths, daemonOptions);
  if (!connection.clientIsOlder) return;
  await onNewer?.(connection.health.version);
  const own = await resolveGenerationFor(paths, ports.version, { lock: options.lock ?? hostKernelLock() });
  if (own === undefined) throw new DaemonStartError(reopenSessionMessage(connection.health.version), paths.logFiles.supervisor, notPointingAtLog);
};

export const restoreDaemon =
  (ports: DaemonPorts, paths: MomongaPaths, onNewer?: NewerListener) =>
  (signal: AbortSignal | undefined): Promise<void> =>
    ensureSessionDaemon(ports, paths, { ...(signal === undefined ? {} : { signal }), ...(onNewer === undefined ? {} : { onNewer }) });

export type RestartOutcome = { kind: 'started'; version: string } | { kind: 'nothing-serving' };

const servingHealth = async (paths: MomongaPaths): Promise<SupervisorHealth | undefined> => {
  const current = await readCurrentGeneration(paths);
  if (current === undefined) return undefined;
  const health = await healthAt(current.sockets.supervisor);
  return health === undefined || health.phase === 'draining' ? undefined : health;
};

export const restartGeneration = async (ports: DaemonPorts, paths: MomongaPaths, options: Omit<EnsureDaemonOptions, 'trigger'> = {}): Promise<RestartOutcome> => {
  const serving = await servingHealth(paths);
  if (serving === undefined) return { kind: 'nothing-serving' };
  const order = orderVersions(ports.version, serving.version);
  if (order === 'older') throw new DaemonStartError(olderCommandMessage(serving.version), paths.logFiles.supervisor, notPointingAtLog);
  if (order === 'unordered') throw new DaemonStartError(unorderedMessage(ports, serving), paths.logFiles.supervisor);
  const connection = await ensureDaemon(ports, paths, { ...options, trigger: order === 'same' ? 'restart' : 'client' });
  return { kind: 'started', version: connection.health.version };
};
