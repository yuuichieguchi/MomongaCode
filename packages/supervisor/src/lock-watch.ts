import { LOCAL_REQUEST_HEADERS_TIMEOUT_MS, createUdsClient, fixedSocket, inspectProcessLock, isTransientFailure } from '@momonga/foundation';
import type { KernelLockMechanism, ProcessLockInspection } from '@momonga/foundation';
import { LINE_MAX_BYTES } from './constants.ts';
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
  lockWatchIntervalMs: number;
  externalPollMs: number;
  timers: SupervisorTimers;
  mechanism?: KernelLockMechanism;
  inspect?: typeof inspectProcessLock;
  probe?: HealthProbe;
  onFree(): void;
  onExternal(holderPid: number | undefined): void;
  onProbe(probe: ExternalProbe): void;
  onTransient(error: unknown, source: string): void;
  onBackgroundError(error: unknown, source: string): void;
};

export type LockWatch = { stop(): void };

export const PROBE_HEADERS_TIMEOUT_MS = LOCAL_REQUEST_HEADERS_TIMEOUT_MS;
export const HEALTH_BODY_MAX_BYTES = LINE_MAX_BYTES;

const HEALTH_PATHS = { runtime: '/v1/health', gateway: '/v1/momonga/health' } as const satisfies Record<ChildRole, string>;

const UNREACHABLE_CODES: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ENOENT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

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

const codeOf = (error: unknown): string | undefined => (error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined);

const readBounded = async (body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<string | undefined> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) return undefined;
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
};

export const createExternalHealthProbe = (timeoutMs: number): HealthProbe => async (role, socketPath) => {
  const client = createUdsClient(fixedSocket(socketPath), { headersTimeoutMs: timeoutMs, bodyTimeoutMs: timeoutMs });
  try {
    const response = await client.request({ method: 'GET', path: HEALTH_PATHS[role] });
    const body = await readBounded(response.body, HEALTH_BODY_MAX_BYTES);
    return body === undefined ? 'unhealthy' : labelHealthResponse(role, { status: response.status, body });
  } catch (error) {
    const code = codeOf(error);
    if (code !== undefined && UNREACHABLE_CODES.has(code)) return 'unreachable';
    throw error;
  } finally {
    await client.destroy();
  }
};

export const probeExternalHealth: HealthProbe = createExternalHealthProbe(PROBE_HEADERS_TIMEOUT_MS);

export const holderPidOf = (inspection: ProcessLockInspection): number | undefined => (inspection.state === 'held' ? inspection.pid : undefined);

export const watchLock = (options: LockWatchOptions): LockWatch => {
  const { timers } = options;
  const inspect = options.inspect ?? inspectProcessLock;
  const probe = options.probe ?? probeExternalHealth;
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

  const report = (error: unknown, source: string): void => {
    if (isTransientFailure(error)) options.onTransient(error, source);
    else options.onBackgroundError(error, source);
  };

  const guarded = (source: string, body: () => void): void => {
    try {
      body();
    } catch (error) {
      options.onBackgroundError(error, source);
    }
  };

  const armProbe = (): void => {
    if (stopped) return;
    probeTimer = timers.setTimeout(() => {
      probeTimer = undefined;
      runProbe();
    }, options.externalPollMs);
  };

  const runProbe = (): void => {
    if (stopped) return;
    probe(options.role, options.socketPath).then(
      (outcome) => {
        if (stopped) return;
        guarded('external-probe', () => options.onProbe(outcome));
        armProbe();
      },
      (error: unknown) => {
        if (stopped) return;
        report(error, 'external-probe');
        armProbe();
      },
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
    }, options.lockWatchIntervalMs);
  };

  const poll = async (): Promise<void> => {
    let inspection: ProcessLockInspection;
    try {
      inspection = await inspect(options.lockPath, omitUndefined({ mechanism: options.mechanism }));
    } catch (error) {
      if (stopped) return;
      report(error, 'lock-poll');
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
