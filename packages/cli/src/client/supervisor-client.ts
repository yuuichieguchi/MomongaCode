import { SUPERVISOR_RESPONSE_BOUND_MS, createUdsClient, isRecord } from '@momonga/foundation';
import type { SupervisorChildHealth, SupervisorHealth, SupervisorPhase, SupervisorShutdownResponse } from '@momonga/protocol';

export type ChildRole = SupervisorChildHealth['role'];

export type SupervisorClient = {
  health(): Promise<SupervisorHealth>;
  shutdown(signal?: AbortSignal): Promise<{ status: number; body: SupervisorShutdownResponse }>;
  shutdownIfIdle(signal?: AbortSignal): Promise<{ accepted: boolean }>;
  close(): Promise<void>;
};

export type SupervisorClientOptions = { socketPath: string; responseBoundMs?: number; onHealth?: (health: SupervisorHealth) => Promise<void> };

const PHASES: ReadonlySet<string> = new Set<SupervisorPhase>(['reaping-orphans', 'running', 'draining']);
const ROLES: ReadonlySet<string> = new Set<ChildRole>(['gateway', 'runtime']);

export const childOf = (health: SupervisorHealth, role: ChildRole): SupervisorChildHealth => {
  const child = health.children.find((entry) => entry.role === role);
  if (child === undefined) throw new Error(`no ${role} child in health`);
  return child;
};

export const pidOf = (health: SupervisorHealth, role: ChildRole): number => {
  const pid = childOf(health, role).pid;
  if (pid === undefined) throw new Error(`${role} has no pid in health`);
  return pid;
};

const isChildHealth = (value: unknown): value is SupervisorChildHealth =>
  isRecord(value) && typeof value['role'] === 'string' && ROLES.has(value['role']) && typeof value['state'] === 'string';

const isSupervisorHealth = (value: unknown): value is SupervisorHealth =>
  isRecord(value) &&
  value['status'] === 'ok' &&
  typeof value['version'] === 'string' &&
  typeof value['pid'] === 'number' &&
  typeof value['phase'] === 'string' &&
  PHASES.has(value['phase']) &&
  Array.isArray(value['children']) &&
  value['children'].every(isChildHealth);

const isShutdownResponse = (value: unknown): value is SupervisorShutdownResponse => isRecord(value) && value['phase'] === 'draining';

export const createSupervisorClient = (options: SupervisorClientOptions): SupervisorClient => {
  const responseBoundMs = options.responseBoundMs ?? SUPERVISOR_RESPONSE_BOUND_MS;
  const http = createUdsClient(options.socketPath, { headersTimeoutMs: responseBoundMs, bodyTimeoutMs: responseBoundMs });

  const health = async (): Promise<SupervisorHealth> => {
    const response = await http.request({ method: 'GET', path: '/v1/health' });
    const text = await response.text();
    if (response.status !== 200) throw new Error(`GET /v1/health answered ${response.status}: ${text}`);
    const body: unknown = JSON.parse(text);
    if (!isSupervisorHealth(body)) throw new Error(`GET /v1/health answered a body that is not a supervisor health: ${text}`);
    await options.onHealth?.(body);
    return body;
  };

  const shutdown = async (signal?: AbortSignal): Promise<{ status: number; body: SupervisorShutdownResponse }> => {
    const response = await http.request({ method: 'POST', path: '/v1/shutdown', ...(signal === undefined ? {} : { signal }) });
    const text = await response.text();
    const body: unknown = JSON.parse(text);
    if (!isShutdownResponse(body)) throw new Error(`POST /v1/shutdown answered ${response.status} with an unexpected body: ${text}`);
    return { status: response.status, body };
  };

  const shutdownIfIdle = async (signal?: AbortSignal): Promise<{ accepted: boolean }> => {
    const response = await http.request({ method: 'POST', path: '/v1/shutdown-if-idle', ...(signal === undefined ? {} : { signal }) });
    const text = await response.text();
    if (response.status === 409) return { accepted: false };
    const body: unknown = JSON.parse(text);
    if (response.status !== 202 || !isShutdownResponse(body)) throw new Error(`POST /v1/shutdown-if-idle answered ${response.status} with an unexpected body: ${text}`);
    return { accepted: true };
  };

  return { health, shutdown, shutdownIfIdle, close: () => http.close() };
};
