import { createUdsClient, isProcessAlive } from '@momonga/foundation';
import type { SupervisorHealth } from '@momonga/protocol';
import { killGroupsForCleanup, registerCleanup } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';

export type SupervisorChildrenTracker = {
  record(health: SupervisorHealth): void;
};

const HEALTH_TIMEOUT_MS = 3000;

const UNREACHABLE_CODES: ReadonlySet<unknown> = new Set(['ECONNREFUSED', 'ENOENT']);

const errnoCodeOf = (error: unknown): unknown => (typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined);

const childPidsOf = (health: SupervisorHealth): number[] => health.children.flatMap((child) => (child.pid === undefined ? [] : [child.pid]));

const childPidsFromBody = (body: unknown): number[] => {
  if (typeof body !== 'object' || body === null || !('children' in body) || !Array.isArray(body.children)) {
    throw new Error('supervisor health body has no children array');
  }
  return body.children.flatMap((child: unknown) => {
    if (typeof child !== 'object' || child === null || !('pid' in child)) return [];
    if (typeof child.pid !== 'number') throw new Error('supervisor health child pid is not a number');
    return [child.pid];
  });
};

const fetchChildPids = async (socketPath: string): Promise<number[]> => {
  const client = createUdsClient(socketPath, { headersTimeoutMs: HEALTH_TIMEOUT_MS, bodyTimeoutMs: HEALTH_TIMEOUT_MS });
  try {
    const response = await client.request({ method: 'GET', path: '/v1/health' });
    if (response.status !== 200) throw new Error(`supervisor health answered ${response.status}`);
    return childPidsFromBody(await response.json());
  } catch (error) {
    if (UNREACHABLE_CODES.has(errnoCodeOf(error))) return [];
    throw error;
  } finally {
    await client.destroy();
  }
};

export const trackSupervisorChildren = (context: CleanupContext, socketPath: string): SupervisorChildrenTracker => {
  const pids = new Set<number>();
  registerCleanup(context, async () => {
    let fetchFailure: { error: unknown } | undefined;
    try {
      for (const pid of await fetchChildPids(socketPath)) pids.add(pid);
    } catch (error) {
      fetchFailure = { error };
    }
    await killGroupsForCleanup([...pids]);
    if (fetchFailure !== undefined) throw fetchFailure.error;
    const survivors = [...pids].filter((pid) => isProcessAlive(pid));
    if (survivors.length > 0) throw new Error(`supervisor children still alive after cleanup: ${survivors.join(', ')}`);
  });
  return {
    record: (health) => {
      for (const pid of childPidsOf(health)) pids.add(pid);
    },
  };
};
