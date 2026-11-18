import path from 'node:path';
import { CONTROL_REQUEST_TIMEOUT_MS, generationLayout, generationSockets, inspectProcessLock, listGenerations, orderVersions, readCurrentGeneration, resolveLayoutLocks, versionSocketResolver } from '@momonga/foundation';
import type { GenerationProcessRole, GenerationRole, KernelLockMechanism, MomongaPaths } from '@momonga/foundation';
import type { SupervisorHealth } from '@momonga/protocol';
import { DAEMON_POLL_INTERVAL_MS } from '../constants.ts';
import type { CliClock, CliPorts } from '../ports.ts';
import type { RetiringWork } from '../update/ports.ts';
import { DaemonStartError, STOP_WAIT_WHEN_UNKNOWN_MS, generationLabel, healthAt, runtimeCountsNotKnown, liveGenerationsUnderLock, reopenSessionMessage } from './ensure-daemon.ts';
import type { NewerListener } from './ensure-daemon.ts';

const homeOf = (paths: MomongaPaths): string => path.dirname(paths.root);

export type LiveGeneration = { generation: number; role: GenerationRole; health: SupervisorHealth };

export type GenerationListingOptions = { lock?: KernelLockMechanism };

export const listLiveGenerations = async (ports: Pick<CliPorts, 'clock' | 'endpointScope'>, paths: MomongaPaths, options: GenerationListingOptions = {}): Promise<LiveGeneration[]> => {
  const lock = options.lock ?? resolveLayoutLocks(paths).mechanism;
  const scope = await ports.endpointScope(paths);
  const generations = await liveGenerationsUnderLock(ports, paths, lock, CONTROL_REQUEST_TIMEOUT_MS);
  const current = await readCurrentGeneration(paths);
  const roleOf = (generation: number): GenerationRole => {
    if (current === undefined || generation > current.generation) return 'starting';
    return generation === current.generation ? 'serving' : 'retiring';
  };
  const dialed = await Promise.all(
    generations.map(async (generation) => {
      const health = await healthAt(generationSockets(homeOf(paths), generation, scope).supervisor);
      return health === undefined ? undefined : { generation, role: roleOf(generation), health };
    }),
  );
  return dialed.filter((entry) => entry !== undefined);
};

const sumOf = (counts: readonly (number | undefined)[]): number => counts.reduce<number>((sum, count) => (count === undefined ? sum : sum + count), 0);

export const retiringWorkOf = (live: readonly LiveGeneration[]): RetiringWork => {
  const retiring = live.filter((entry) => entry.role === 'retiring');
  return {
    steps: sumOf(retiring.map((entry) => entry.health.steps)),
    jobs: sumOf(retiring.map((entry) => entry.health.jobs)),
    versions: [...new Set(retiring.map((entry) => entry.health.version))],
    notKnown: retiring.filter((entry) => runtimeCountsNotKnown(entry.health)).map((entry) => generationLabel(entry.health)),
  };
};

export const sessionSocketResolver =
  (ports: Pick<CliPorts, 'version' | 'endpointScope'>, paths: MomongaPaths, role: GenerationProcessRole, options: GenerationListingOptions = {}): (() => Promise<string>) =>
  async () =>
    versionSocketResolver(paths, ports.version, role, { lock: options.lock ?? resolveLayoutLocks(paths).mechanism, scope: await ports.endpointScope(paths) })();

export const endSessionWhenMovedAway =
  (paths: MomongaPaths, version: string, onNewer?: NewerListener): (() => Promise<void>) =>
  async () => {
    const current = await readCurrentGeneration(paths);
    if (current === undefined || current.version === version) return;
    if (orderVersions(version, current.version) === 'older') await onNewer?.(current.version, 'gone');
    throw new DaemonStartError(reopenSessionMessage(current.version), paths.logFiles.supervisor, { pointsAtLog: false });
  };

const KILL_WAIT_MS = 5_000;

export type ProcessEffects = {
  clock: CliClock;
  isAlive(pid: number): boolean;
  signal(pid: number, signal: NodeJS.Signals, group: boolean): void;
};

const gone = async (effects: ProcessEffects, pid: number, boundMs: number): Promise<boolean> => {
  const until = effects.clock.now() + boundMs;
  while (effects.isAlive(pid)) {
    if (effects.clock.now() >= until) return false;
    await effects.clock.sleep(DAEMON_POLL_INTERVAL_MS);
  }
  return true;
};

const stopSupervisor = async (effects: ProcessEffects, pid: number): Promise<void> => {
  effects.signal(pid, 'SIGTERM', false);
  if (await gone(effects, pid, STOP_WAIT_WHEN_UNKNOWN_MS)) return;
  effects.signal(pid, 'SIGKILL', true);
  effects.signal(pid, 'SIGKILL', false);
  if (!(await gone(effects, pid, KILL_WAIT_MS))) throw new Error(`the daemon with pid ${pid} did not stop after SIGTERM and SIGKILL`);
};

export const stopAllGenerations = async (effects: ProcessEffects, paths: MomongaPaths, options: GenerationListingOptions = {}): Promise<void> => {
  const lock = options.lock ?? resolveLayoutLocks(paths).mechanism;
  const pids: number[] = [];
  for (const listed of await listGenerations(paths, { lock })) {
    if (!listed.supervisorHeld) continue;
    const holder = await inspectProcessLock(generationLayout(homeOf(paths), listed.generation).locks.supervisor, { mechanism: lock });
    if (holder.state === 'held') pids.push(holder.pid);
  }
  await Promise.all(pids.map((pid) => stopSupervisor(effects, pid)));
};
