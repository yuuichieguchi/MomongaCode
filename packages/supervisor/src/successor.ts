import { beginGenerationStart, generationLayout, lockReadsHeld, orderVersions } from '@momonga/foundation';
import type { HeldStart, JsonLogger, KernelLockMechanism, MomongaPaths } from '@momonga/foundation';
import type { SupervisorTimers } from './constants.ts';
import { generationSuccessor, writeEvent } from './log-events.ts';

export type SuccessorLaunch = { pid: number | undefined; exit?: Promise<unknown> };

export type SuccessorLauncher = { launch(generation: number): SuccessorLaunch };

export type SuccessorOutcome = 'started' | 'joined' | 'below-floor' | 'already-tried' | 'no-launcher' | 'busy' | 'not-needed' | 'spawn-failed' | 'prepare-failed';

export type SuccessorOptions = {
  home: string;
  paths: MomongaPaths;
  generation: number;
  version: string;
  foldVersion: number;
  lock: KernelLockMechanism;
  launcher: SuccessorLauncher | undefined;
  timers: SupervisorTimers;
  pollMs: number;
  boundMs: number;
  logger: JsonLogger;
  onError(error: unknown): void;
};

export type Successor = {
  request(installedVersion: string): Promise<SuccessorOutcome>;
  stop(): void;
};

export const createSuccessor = (options: SuccessorOptions): Successor => {
  const { paths, timers, logger } = options;
  const attempted = new Set<string>();
  const held = new Set<HeldStart>();
  const watchTimers = new Set<unknown>();
  let stopped = false;

  const report = (successor: number | undefined, version: string, outcome: SuccessorOutcome): SuccessorOutcome => {
    writeEvent(logger, generationSuccessor({ generation: options.generation, successor: successor ?? null, version, outcome }));
    return outcome;
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const handle = timers.setTimeout(() => {
        watchTimers.delete(handle);
        resolve();
      }, ms);
      watchTimers.add(handle);
    });

  const releaseStart = (start: HeldStart): void => {
    if (!held.delete(start)) return;
    start.release();
  };

  const holdUntilClaimed = async (successor: number, start: HeldStart): Promise<void> => {
    const supervisorLock = generationLayout(options.home, successor).locks.supervisor;
    try {
      for (let waited = 0; waited < options.boundMs && !stopped && held.has(start); waited += options.pollMs) {
        if (await lockReadsHeld(supervisorLock, { lock: options.lock })) return;
        await sleep(options.pollMs);
      }
    } finally {
      releaseStart(start);
    }
  };

  const begin = async (installedVersion: string): Promise<Awaited<ReturnType<typeof beginGenerationStart>>> => {
    for (let waited = 0; ; waited += options.pollMs) {
      const outcome = await beginGenerationStart(paths, { version: installedVersion, foldVersion: options.foldVersion, lock: options.lock, trigger: 'childMismatch' });
      if (outcome.kind !== 'busy' || waited >= options.boundMs || stopped) return outcome;
      await sleep(options.pollMs);
    }
  };

  const request = async (installedVersion: string): Promise<SuccessorOutcome> => {
    if (orderVersions(installedVersion, options.version) !== 'newer') return report(undefined, installedVersion, 'below-floor');
    if (attempted.has(installedVersion)) return 'already-tried';
    attempted.add(installedVersion);
    const launcher = options.launcher;
    if (launcher === undefined) return report(undefined, installedVersion, 'no-launcher');
    let outcome: Awaited<ReturnType<typeof beginGenerationStart>>;
    try {
      outcome = await begin(installedVersion);
    } catch (error) {
      options.onError(error);
      return report(undefined, installedVersion, 'prepare-failed');
    }
    if (outcome.kind === 'busy') return report(undefined, installedVersion, 'busy');
    if (outcome.kind === 'joined') return report(outcome.generation, installedVersion, 'joined');
    if (outcome.kind !== 'allocated') return report(undefined, installedVersion, outcome.kind === 'below-floor' ? 'below-floor' : 'not-needed');
    const { generation: successor, starting } = outcome;
    const spawnFailed = (error: unknown): SuccessorOutcome => {
      releaseStart(starting);
      options.onError(error);
      return report(successor, installedVersion, 'spawn-failed');
    };
    held.add(starting);
    let launched: SuccessorLaunch;
    try {
      launched = launcher.launch(successor);
    } catch (error) {
      return spawnFailed(error);
    }
    void launched.exit?.then(undefined, spawnFailed);
    void holdUntilClaimed(successor, starting).catch(options.onError);
    return report(successor, installedVersion, 'started');
  };

  return {
    request,
    stop: () => {
      stopped = true;
      for (const handle of watchTimers) timers.clearTimeout(handle);
      watchTimers.clear();
      for (const start of [...held]) releaseStart(start);
    },
  };
};
