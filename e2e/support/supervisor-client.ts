import { createUdsClient } from '@momonga/foundation';
import type { SupervisorChildHealth, SupervisorHealth, SupervisorPhase, SupervisorShutdownResponse } from '@momonga/protocol';
import type { ChildRole } from '@momonga/supervisor';
import type { E2eHome } from './home.ts';
import { until } from './wait.ts';
import { isRecord } from './is-record.ts';

export type SupervisorClient = {
  health(): Promise<SupervisorHealth>;
  shutdown(): Promise<{ status: number; body: SupervisorShutdownResponse }>;
  untilPhase(phase: SupervisorPhase, deadlineMs: number): Promise<SupervisorHealth>;
  untilChild(role: ChildRole, predicate: (child: SupervisorChildHealth) => boolean, deadlineMs: number): Promise<SupervisorChildHealth>;
  close(): Promise<void>;
};

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
  typeof value['pid'] === 'number' &&
  typeof value['phase'] === 'string' &&
  PHASES.has(value['phase']) &&
  Array.isArray(value['children']) &&
  value['children'].every(isChildHealth);

const isShutdownResponse = (value: unknown): value is SupervisorShutdownResponse => isRecord(value) && value['phase'] === 'draining';

export const createSupervisorClient = (home: E2eHome): SupervisorClient => {
  const http = createUdsClient(home.paths.sockets.supervisor);

  const health = async (): Promise<SupervisorHealth> => {
    const response = await http.request({ method: 'GET', path: '/v1/health' });
    const text = await response.text();
    if (response.status !== 200) throw new Error(`GET /v1/health answered ${response.status}: ${text}`);
    const body: unknown = JSON.parse(text);
    if (!isSupervisorHealth(body)) throw new Error(`GET /v1/health answered a body that is not a supervisor health: ${text}`);
    await home.ledger.record(body);
    return body;
  };

  const shutdown = async (): Promise<{ status: number; body: SupervisorShutdownResponse }> => {
    await health();
    const response = await http.request({ method: 'POST', path: '/v1/shutdown' });
    const text = await response.text();
    const body: unknown = JSON.parse(text);
    if (!isShutdownResponse(body)) throw new Error(`POST /v1/shutdown answered ${response.status} with an unexpected body: ${text}`);
    return { status: response.status, body };
  };

  const untilPhase = (phase: SupervisorPhase, deadlineMs: number): Promise<SupervisorHealth> =>
    until(async () => {
      const current = await health();
      return current.phase === phase ? current : undefined;
    }, { deadlineMs, description: `supervisor phase ${phase}` });

  const untilChild = (role: ChildRole, predicate: (child: SupervisorChildHealth) => boolean, deadlineMs: number): Promise<SupervisorChildHealth> =>
    until(async () => {
      const child = childOf(await health(), role);
      return predicate(child) ? child : undefined;
    }, { deadlineMs, description: `${role} child to match the awaited state` });

  return { health, shutdown, untilPhase, untilChild, close: () => http.close() };
};
