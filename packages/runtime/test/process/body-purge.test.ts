import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BODY_PURGE_INTERVAL_MS } from '@momonga/observability';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { launchRuntime, readDb, startStack } from './run-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

type Purge = { ticks: (() => void)[]; legacyRetentionMs: number | undefined; stops: number };

const control = vi.hoisted(() => ({ purges: [] as Purge[] }));

vi.mock('@momonga/observability', async (importOriginal) => {
  const original = await importOriginal<typeof import('@momonga/observability')>();
  return {
    ...original,
    startBodyPurge: (options: Parameters<typeof original.startBodyPurge>[0]) => {
      const record: Purge = { ticks: [], legacyRetentionMs: options.legacyRetentionMs, stops: 0 };
      control.purges.push(record);
      const purge = original.startBodyPurge({
        ...options,
        timers: {
          setTimeout: (callback, ms) => {
            if (ms === original.BODY_PURGE_INTERVAL_MS) record.ticks.push(callback);
            return record.ticks.length;
          },
          clearTimeout: () => undefined,
        },
      });
      return {
        stop: () => {
          record.stops += 1;
          purge.stop();
        },
      };
    },
  };
});

const PROCESS_TIMEOUT = { timeout: REAL_PROCESS_TEST_TIMEOUT_MS };

const DAY_MS = 86_400_000;
const BODY_KIND = 'gen_ai.input.messages';

const insertBody = (file: string, spanId: string, expiresAtMs: number): void => {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare('INSERT INTO bodies (trace_id, span_id, kind, content, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?)').run('t'.repeat(32), spanId, BODY_KIND, 'content', 1, expiresAtMs);
  } finally {
    db.close();
  }
};

const spanIdsOfBodies = (file: string): string[] => readDb<{ span_id: string }>(file, 'SELECT span_id FROM bodies ORDER BY id').map((row) => row.span_id);

beforeEach(() => {
  control.purges = [];
});

describe('the runtime process owns a trace store and starts the body purge', () => {
  it('starts one purge timer on the runtime trace store, purges expired bodies on its tick and stops it at close', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    control.purges = [];
    const launched = await launchRuntime(stack.temp);
    expect(control.purges).toHaveLength(1);
    const [purge] = control.purges as [Purge];
    expect(purge.ticks).toHaveLength(1);
    expect(BODY_PURGE_INTERVAL_MS).toBeGreaterThan(0);

    const traces = stack.temp.paths.traces.runtime;
    insertBody(traces, 'expired-span', 2);
    insertBody(traces, 'kept-span', Date.now() + DAY_MS);
    expect(spanIdsOfBodies(traces)).toEqual(['expired-span', 'kept-span']);
    purge.ticks[0]?.();
    expect(spanIdsOfBodies(traces)).toEqual(['kept-span']);

    expect(purge.stops).toBe(0);
    await launched.handle.close();
    expect(purge.stops).toBe(1);
  });

  it('hands the content retention to the legacy move: 30 days by default', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    control.purges = [];
    await launchRuntime(stack.temp);
    expect(control.purges).toHaveLength(1);
    expect(control.purges[0]?.legacyRetentionMs).toBe(30 * DAY_MS);
  });

  it('hands the configured telemetry.contentRetentionDays to the legacy move', PROCESS_TIMEOUT, async () => {
    const stack = await startStack({}, { telemetry: { contentRetentionDays: 7 } });
    control.purges = [];
    await launchRuntime(stack.temp);
    expect(control.purges).toHaveLength(1);
    expect(control.purges[0]?.legacyRetentionMs).toBe(7 * DAY_MS);
  });
});
