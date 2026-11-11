import { SUPERVISOR_RESPONSE_BOUND_MS, createUdsClient, isRecord } from '@momonga/foundation';
import type { SocketResolver, StopValues } from '@momonga/foundation';
import type { SupervisorChildHealth, SupervisorHealth, SupervisorPhase, SupervisorShutdownResponse } from '@momonga/protocol';

export type ChildRole = SupervisorChildHealth['role'];

export type SupervisorClient = {
  health(): Promise<SupervisorHealth>;
  shutdown(values?: StopValues, signal?: AbortSignal): Promise<{ status: number; body: SupervisorShutdownResponse }>;
  close(): Promise<void>;
};

export type SupervisorClientOptions = { resolveSocket: SocketResolver; responseBoundMs?: number; onHealth?: (health: SupervisorHealth) => Promise<void> };

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
  value['children'].every(isChildHealth) &&
  (value['stopBoundMs'] === undefined || (typeof value['stopBoundMs'] === 'number' && Number.isInteger(value['stopBoundMs']) && value['stopBoundMs'] >= 0));

const isShutdownResponse = (value: unknown): value is SupervisorShutdownResponse => isRecord(value) && value['phase'] === 'draining';

export const createSupervisorClient = (options: SupervisorClientOptions): SupervisorClient => {
  const responseBoundMs = options.responseBoundMs ?? SUPERVISOR_RESPONSE_BOUND_MS;
  const http = createUdsClient(options.resolveSocket, { connectTimeoutMs: responseBoundMs, headersTimeoutMs: responseBoundMs, bodyTimeoutMs: responseBoundMs });

  const health = async (): Promise<SupervisorHealth> => {
    const response = await http.request({ method: 'GET', path: '/v1/health' });
    const text = await response.text();
    if (response.status !== 200) throw new Error(`GET /v1/health answered ${response.status}: ${text}`);
    const body: unknown = JSON.parse(text);
    if (!isSupervisorHealth(body)) throw new Error(`GET /v1/health answered a body that is not a supervisor health: ${text}`);
    await options.onHealth?.(body);
    return body;
  };

  const shutdown = async (values?: StopValues, signal?: AbortSignal): Promise<{ status: number; body: SupervisorShutdownResponse }> => {
    const response = await http.request({
      method: 'POST',
      path: '/v1/shutdown',
      ...(values === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) }),
      ...(signal === undefined ? {} : { signal }),
    });
    const text = await response.text();
    const body: unknown = JSON.parse(text);
    if (!isShutdownResponse(body)) throw new Error(`POST /v1/shutdown answered ${response.status} with an unexpected body: ${text}`);
    return { status: response.status, body };
  };

  return { health, shutdown, close: () => http.close() };
};
