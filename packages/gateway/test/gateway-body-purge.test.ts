import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { BODY_PURGE_INTERVAL_MS } from '@momonga/observability';
import { startFake } from './cc-support.ts';
import { PROCESS_VERSION, baseEnv, captureStdout, ccTarget, homePaths, launchGateway, makeHome, writeSettings, modelsOf } from './gateway-process-helpers.ts';
import { FIRST_GENERATION } from '@momonga/foundation';

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

const DAY_MS = 86_400_000;
const BODY_KIND = 'gen_ai.input.messages';

const tracesOf = (home: string): string => path.join(homePaths(home).root, 'state', 'traces', 'gateway.db');

const insertBody = (file: string, spanId: string, expiresAtMs: number): void => {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare('INSERT INTO bodies (trace_id, span_id, kind, content, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?)').run('t'.repeat(32), spanId, BODY_KIND, 'content', 1, expiresAtMs);
  } finally {
    db.close();
  }
};

const spanIdsOfBodies = (file: string): string[] => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare('SELECT span_id FROM bodies ORDER BY id').all() as { span_id: string }[]).map((row) => row.span_id);
  } finally {
    db.close();
  }
};

const startWith = async (retention?: Record<string, unknown>) => {
  const fake = await startFake({ scenario: 'tools-ok' });
  const home = makeHome();
  writeSettings(home, {
    models: modelsOf({ primary: ccTarget(fake.socketPath) }),
    ...(retention === undefined ? {} : { retention }),
  });
  captureStdout();
  const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION });
  return { home, handle };
};

beforeEach(() => {
  control.purges = [];
});

describe('the gateway process owns a trace store and starts the body purge', () => {
  it('starts one purge timer on the gateway trace store, purges expired bodies on its tick and stops it at close', async () => {
    const { home, handle } = await startWith();
    expect(control.purges).toHaveLength(1);
    const [purge] = control.purges as [Purge];
    expect(purge.ticks).toHaveLength(1);
    expect(BODY_PURGE_INTERVAL_MS).toBeGreaterThan(0);

    insertBody(tracesOf(home), 'expired-span', 2);
    insertBody(tracesOf(home), 'kept-span', Date.now() + DAY_MS);
    expect(spanIdsOfBodies(tracesOf(home))).toEqual(['expired-span', 'kept-span']);
    purge.ticks[0]?.();
    expect(spanIdsOfBodies(tracesOf(home))).toEqual(['kept-span']);

    expect(purge.stops).toBe(0);
    await handle.close();
    expect(purge.stops).toBe(1);
  });

  it('hands the content retention to the legacy move: 30 days by default', async () => {
    await startWith();
    expect(control.purges[0]?.legacyRetentionMs).toBe(30 * DAY_MS);
  });

  it('hands the configured retention.days to the legacy move', async () => {
    await startWith({ days: 7 });
    expect(control.purges[0]?.legacyRetentionMs).toBe(7 * DAY_MS);
  });
});
