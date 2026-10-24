import type { JsonLogger } from '@momonga/foundation';
import { SHUTDOWN_REAP_BOUND_MS, SHUTDOWN_RELEASE_BOUND_MS } from './constants.ts';
import type { SupervisorTimers } from './constants.ts';
import { stopBudgetMs } from './child-manager.ts';
import type { ChildManager, ChildStopResult } from './child-manager.ts';
import type { ChildRole } from './launcher.ts';
import { orphansWarning, shutdownBegin, shutdownEnd, shutdownStep, shutdownStepBound, writeEvent } from './log-events.ts';
import { omitUndefined } from './omit-undefined.ts';
import { reapDaemonMarker } from './orphans.ts';
import type { MarkerPorts } from './orphans.ts';
import type { StopMode } from './restart-policy.ts';
import type { SupervisorCloseResult } from './start-supervisor.ts';

export type ShutdownMode = 'idle' | 'closing' | 'aborting';

export type ShutdownControllerOptions = {
  runtime: ChildManager;
  gateway: ChildManager;
  drainTimeoutMs: number;
  timers: SupervisorTimers;
  logger: JsonLogger;
  markerPorts?: MarkerPorts;
  beginDraining(): void;
  awaitBackground(): Promise<void>;
  closeControl(): Promise<void>;
  releaseLock(): void;
  onFatal(error: Error): void;
};

export type ShutdownController = {
  mode(): ShutdownMode;
  close(): Promise<SupervisorCloseResult>;
  abort(): Promise<SupervisorCloseResult>;
  readonly closed: Promise<SupervisorCloseResult>;
};

export const childCloseBudgetMs = (role: ChildRole, mode: StopMode, drainTimeoutMs: number): number => stopBudgetMs(role, mode, drainTimeoutMs);

const MAX_REAP_ATTEMPTS = 2;

const failureOf = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

export const createShutdownController = (options: ShutdownControllerOptions): ShutdownController => {
  const { runtime, gateway, timers, logger } = options;
  const managers = [runtime, gateway] as const;
  let mode: ShutdownMode = 'idle';
  let resolveClosed: (result: SupervisorCloseResult) => void = () => undefined;
  const closed = new Promise<SupervisorCloseResult>((resolve) => {
    resolveClosed = resolve;
  });
  const log = writeEvent.bind(undefined, logger);

  const stopMode = (): StopMode => (mode === 'aborting' ? 'int' : 'term');

  const stopManager = (manager: ChildManager): Promise<ChildStopResult> => manager.stop('shutdown', stopMode());

  const reapStep = async (triedBefore: ReadonlyMap<ChildRole, ReadonlySet<string>>): Promise<void> => {
    let expired = false;
    let wake: () => void = () => undefined;
    const boundReached = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const boundTimer = timers.setTimeout(() => {
      expired = true;
      wake();
    }, SHUTDOWN_REAP_BOUND_MS);
    const finished = new Set<string>();

    const reapMarker = async (marker: string, attemptsMade: number): Promise<void> => {
      let made = attemptsMade;
      while (made < MAX_REAP_ATTEMPTS && !expired) {
        const result = await reapDaemonMarker({ marker, logger, ...omitUndefined({ markerPorts: options.markerPorts }) });
        made += 1;
        if (result.removed) break;
      }
      finished.add(marker);
    };

    const reapRole = async (manager: ChildManager): Promise<void> => {
      const before = new Set(manager.unreapedMarkers());
      const tried = triedBefore.get(manager.role) ?? new Set<string>();
      await Promise.all(
        manager.unreapedMarkers().map(async (marker) => {
          await manager.inFlightReaps().get(marker);
          if (!manager.unreapedMarkers().includes(marker)) return;
          await reapMarker(marker, tried.has(marker) || !before.has(marker) ? 1 : 0);
        }),
      );
    };

    await Promise.race([Promise.all(managers.map((manager) => reapRole(manager))), boundReached]);
    timers.clearTimeout(boundTimer);
    if (expired) {
      for (const manager of managers) {
        for (const marker of manager.unreapedMarkers()) {
          if (!finished.has(marker)) log(orphansWarning({ detail: 'step 4 bound reached', marker }));
        }
      }
    }
  };

  const run = async (): Promise<SupervisorCloseResult> => {
    log(shutdownBegin({ mode: mode === 'aborting' ? 'abort' : 'close' }));
    options.beginDraining();
    for (const manager of managers) manager.enterDraining();
    const triedBefore = new Map<ChildRole, ReadonlySet<string>>(managers.map((manager) => [manager.role, new Set(manager.unreapedMarkers())]));
    log(shutdownStep({ shutdownStep: 1, detail: 'draining' }));
    await options.awaitBackground();

    const killed: ChildRole[] = [];
    const leaked: ChildRole[] = [];
    const record = (role: ChildRole, result: ChildStopResult): void => {
      if (result.killed) killed.push(role);
      if (result.leaked) leaked.push(role);
    };

    if (mode === 'aborting') {
      log(shutdownStep({ shutdownStep: 2, detail: 'signal both children' }));
      const results = await Promise.all(managers.map((manager) => stopManager(manager)));
      managers.forEach((manager, index) => record(manager.role, results[index] as ChildStopResult));
    } else {
      log(shutdownStep({ shutdownStep: 2, detail: 'stop runtime' }));
      record('runtime', await stopManager(runtime));
      log(shutdownStep({ shutdownStep: 3, detail: 'stop gateway' }));
      record('gateway', await stopManager(gateway));
    }

    log(shutdownStep({ shutdownStep: 4, detail: 'reap markers' }));
    await reapStep(triedBefore);

    log(shutdownStep({ shutdownStep: 5, detail: 'release control' }));
    let fatal: Error | undefined;
    const fail = (error: unknown): void => {
      const failure = failureOf(error);
      fatal ??= failure;
      options.onFatal(failure);
    };
    let releaseTimer: unknown;
    let boundExpired = false;
    const boundReached = new Promise<'bound'>((resolve) => {
      releaseTimer = timers.setTimeout(() => { boundExpired = true; resolve('bound'); }, SHUTDOWN_RELEASE_BOUND_MS);
    });
    try {
      const closing = options.closeControl();
      closing.catch((error: unknown) => {
        if (boundExpired) fail(error);
      });
      const outcome = await Promise.race([closing.then(() => 'closed' as const), boundReached]);
      if (outcome === 'bound') log(shutdownStepBound({ shutdownStep: 5, detail: 'step 5 bound reached' }));
    } catch (error) {
      fail(error);
    } finally {
      timers.clearTimeout(releaseTimer);
    }
    try {
      options.releaseLock();
    } catch (error) {
      fail(error);
    }

    const clean = killed.length === 0 && leaked.length === 0 && fatal === undefined;
    log(shutdownEnd({ clean, killed: killed.join(','), leaked: leaked.join(',') }));
    return { clean, killed, leaked, ...(fatal === undefined ? {} : { fatal }) };
  };

  const begin = (next: 'closing' | 'aborting'): void => {
    mode = next;
    run().then(resolveClosed, (error: unknown) => {
      const failure = failureOf(error);
      options.onFatal(failure);
      resolveClosed({ clean: false, killed: [], leaked: [], fatal: failure });
    });
  };

  const escalate = (): void => {
    for (const manager of managers) void manager.stop('shutdown', 'int');
  };

  return {
    mode: () => mode,
    close: () => {
      if (mode === 'idle') begin('closing');
      return closed;
    },
    abort: () => {
      if (mode === 'idle') begin('aborting');
      else if (mode === 'closing') {
        mode = 'aborting';
        escalate();
      }
      return closed;
    },
    closed,
  };
};
