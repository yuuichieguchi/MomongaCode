import type { JsonLogger } from '@momonga/foundation';
import type { McpPool } from '@momonga/mcp';
import type { RuntimeStore } from '@momonga/store';
import type { RunNotifier } from '../service/notifier.ts';
import type { ServiceTimers } from '../service/timers.ts';
import { isTerminalStatus } from '../service/views.ts';
import { asError } from './as-error.ts';
import { POOL_IDLE_CLOSE_MS, POOL_REFERENCE_AUDIT_MS } from './constants.ts';

export type McpPoolCacheOptions = {
  store: Pick<RuntimeStore, 'getRun'>;
  notifier: Pick<RunNotifier, 'watchRun'>;
  timers: ServiceTimers;
  logger: JsonLogger;
  report(error: unknown): void;
};

export type McpPoolCache = {
  acquire(runId: string, spec: { key: string; create(): McpPool }): { pool: McpPool; changed: boolean };
  release(runId: string): boolean;
  closeAll(): Promise<void>;
  size(): number;
};

type Entry = { pool: McpPool; refs: Set<string>; idle?: unknown };

type Reference = { key: string; unwatch(): void };

export const createMcpPoolCache = ({ store, notifier, timers, logger, report }: McpPoolCacheOptions): McpPoolCache => {
  const pools = new Map<string, Entry>();
  const runRefs = new Map<string, Reference>();
  const closing = new Set<Promise<void>>();
  let closed = false;
  let audit: { handle: unknown } | undefined;

  const clearIdle = (entry: Entry): void => {
    if (entry.idle === undefined) return;
    timers.clearTimeout(entry.idle);
    delete entry.idle;
  };

  const clearAudit = (): void => {
    if (audit === undefined) return;
    timers.clearTimeout(audit.handle);
    audit = undefined;
  };

  const check = (runId: string): void => {
    if (closed) return;
    try {
      const status = store.getRun(runId)?.status;
      if (status === undefined || isTerminalStatus(status)) release(runId);
    } catch (error) {
      report(error);
    }
  };

  const armAudit = (): void => {
    if (audit !== undefined) return;
    const armed: { handle: unknown } = { handle: undefined };
    armed.handle = timers.setTimeout(() => {
      if (audit === armed) audit = undefined;
      if (closed) return;
      for (const runId of [...runRefs.keys()]) check(runId);
      if (runRefs.size > 0) armAudit();
    }, POOL_REFERENCE_AUDIT_MS);
    audit = armed;
  };

  const closeIdle = (key: string, entry: Entry): void => {
    if (pools.get(key) !== entry) return;
    pools.delete(key);
    delete entry.idle;
    const settled = entry.pool.close().catch((error: unknown) => {
      const failure = asError(error);
      logger.warn(`MCP pool idle close failed: ${failure.message}`, { err: failure });
    });
    const tracked = settled.finally(() => {
      closing.delete(tracked);
    });
    closing.add(tracked);
  };

  const release = (runId: string): boolean => {
    const reference = runRefs.get(runId);
    if (reference === undefined) return false;
    reference.unwatch();
    runRefs.delete(runId);
    const entry = pools.get(reference.key);
    if (entry !== undefined) {
      entry.refs.delete(runId);
      if (entry.refs.size === 0 && entry.idle === undefined) {
        entry.idle = timers.setTimeout(() => closeIdle(reference.key, entry), POOL_IDLE_CLOSE_MS);
      }
    }
    if (runRefs.size === 0) clearAudit();
    return true;
  };

  return {
    acquire: (runId, spec) => {
      if (closed) throw new Error('the MCP pool cache is closed');
      const held = runRefs.get(runId);
      if (held?.key === spec.key) {
        const existing = pools.get(spec.key);
        if (existing !== undefined) return { pool: existing.pool, changed: false };
      }
      if (held !== undefined) release(runId);
      let entry = pools.get(spec.key);
      if (entry === undefined) {
        entry = { pool: spec.create(), refs: new Set() };
        pools.set(spec.key, entry);
      }
      clearIdle(entry);
      entry.refs.add(runId);
      runRefs.set(runId, { key: spec.key, unwatch: notifier.watchRun(runId, () => check(runId)) });
      queueMicrotask(() => check(runId));
      armAudit();
      return { pool: entry.pool, changed: true };
    },
    release,
    closeAll: async () => {
      closed = true;
      clearAudit();
      const open = [...pools.values()];
      for (const entry of open) clearIdle(entry);
      for (const reference of runRefs.values()) reference.unwatch();
      runRefs.clear();
      pools.clear();
      await Promise.allSettled([...open.map((entry) => entry.pool.close()), ...closing]);
    },
    size: () => pools.size,
  };
};
