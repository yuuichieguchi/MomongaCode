import { createLockVerdictMemo, createUdsClient, inspectProcessLock } from '@momonga/foundation';
import type { LockTiming, ProcessLockInspection, ProcessStartProbe } from '@momonga/foundation';
import type { SupervisorTimers } from './constants.ts';
import type { ChildRole } from './launcher.ts';
import { omitUndefined } from './omit-undefined.ts';

export type ExternalProbe = 'pending' | 'healthy' | 'unhealthy' | 'unreachable';

export type ProbeOutcome = Exclude<ExternalProbe, 'pending'>;

export type HealthProbe = (role: ChildRole, socketPath: string) => Promise<ProbeOutcome>;

export type LockWatchOptions = {
  role: ChildRole;
  lockPath: string;
  socketPath: string;
  lockWaitMs: number;
  lockPollMs: number;
  externalPollMs: number;
  timers: SupervisorTimers;
  startTimeOf?: ProcessStartProbe;
  timing?: LockTiming;
  inspect?: typeof inspectProcessLock;
  probe?: HealthProbe;
  onFree(): void;
  onExternal(holderPid: number | undefined): void;
  onProbe(probe: ExternalProbe): void;
  onBackgroundError(error: unknown, source: string): void;
};

export type LockWatch = { stop(): void };

export const PROBE_HEADERS_TIMEOUT_MS = 2000;

const HEALTH_PATHS = { runtime: '/v1/health', gateway: '/v1/momonga/health' } as const satisfies Record<ChildRole, string>;

const parseJsonObject = (text: string): Record<string, unknown> | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
};

export const labelHealthResponse = (role: ChildRole, response: { status: number; body: string }): 'healthy' | 'unhealthy' => {
  if (response.status !== 200) return 'unhealthy';
  const body = parseJsonObject(response.body);
  if (body === undefined || body['state'] !== 'running') return 'unhealthy';
  if (role === 'runtime' && body['status'] !== 'ok') return 'unhealthy';
  return 'healthy';
};

export const probeExternalHealth: HealthProbe = async (role, socketPath) => {
  const client = createUdsClient(socketPath, { headersTimeoutMs: PROBE_HEADERS_TIMEOUT_MS, bodyTimeoutMs: PROBE_HEADERS_TIMEOUT_MS });
  try {
    const response = await client.request({ method: 'GET', path: HEALTH_PATHS[role] });
    const body = await response.text();
    return labelHealthResponse(role, { status: response.status, body });
  } catch {
    return 'unreachable';
  } finally {
    await client.destroy();
  }
};

export const holderPidOf = (inspection: ProcessLockInspection): number | undefined => (inspection.state === 'held' ? inspection.pid : undefined);

export const watchLock = (options: LockWatchOptions): LockWatch => {
  const { timers } = options;
  const inspect = options.inspect ?? inspectProcessLock;
  const probe = options.probe ?? probeExternalHealth;
  const memo = createLockVerdictMemo();
  let stopped = false;
  let deadlinePassed = false;
  let external = false;
  let pollTimer: unknown;
  let probeTimer: unknown;
  let deadlineTimer: unknown;

  const stop = (): void => {
    stopped = true;
    for (const handle of [pollTimer, probeTimer, deadlineTimer]) if (handle !== undefined) timers.clearTimeout(handle);
    pollTimer = undefined;
    probeTimer = undefined;
    deadlineTimer = undefined;
  };

  const guarded = (source: string, body: () => void): void => {
    try {
      body();
    } catch (error) {
      options.onBackgroundError(error, source);
    }
  };

  const runProbe = (): void => {
    if (stopped) return;
    probeTimer = timers.setTimeout(() => {
      probeTimer = undefined;
      runProbe();
    }, options.externalPollMs);
    probe(options.role, options.socketPath).then(
      (outcome) => {
        if (!stopped) guarded('external-probe', () => options.onProbe(outcome));
      },
      (error: unknown) => options.onBackgroundError(error, 'external-probe'),
    );
  };

  const enterExternal = (holderPid: number | undefined): void => {
    external = true;
    options.onExternal(holderPid);
    runProbe();
  };

  const armPoll = (): void => {
    if (stopped) return;
    pollTimer = timers.setTimeout(() => {
      pollTimer = undefined;
      poll().catch((error: unknown) => options.onBackgroundError(error, 'lock-poll'));
    }, options.lockPollMs);
  };

  const poll = async (): Promise<void> => {
    let inspection: ProcessLockInspection;
    try {
      inspection = await inspect(options.lockPath, { ...omitUndefined({ startTimeOf: options.startTimeOf, timing: options.timing }), memo });
    } catch (error) {
      if (stopped) return;
      options.onBackgroundError(error, 'lock-poll');
      armPoll();
      return;
    }
    if (stopped) return;
    try {
      if (inspection.state === 'free') {
        stop();
        options.onFree();
        return;
      }
      if (deadlinePassed && !external) enterExternal(holderPidOf(inspection));
    } catch (error) {
      options.onBackgroundError(error, 'lock-poll');
    }
    armPoll();
  };

  deadlineTimer = timers.setTimeout(() => {
    deadlineTimer = undefined;
    deadlinePassed = true;
  }, options.lockWaitMs);
  armPoll();

  return { stop };
};
