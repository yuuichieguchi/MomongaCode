import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as foundation from '@momonga/foundation';
import { ensureMomongaDirs } from '@momonga/foundation';
import type { ProcessInspector, ReapMarkedProcessesOptions } from '@momonga/foundation';
import { openRuntimeStore } from '@momonga/store';
import { createFakeClock } from '@momonga/testkit';
import { createMarkerOwners } from '@momonga/tools';
import { reapToolMarkers } from '../../src/process/tool-markers.ts';
import { START_MS, makeTempHome } from './helpers.ts';

type MarkerGroupApi = { recordMarkerGroup(marker: string, pgid: number): Promise<void> };

const markerGroups = foundation as unknown as MarkerGroupApi;

const KEY = 'a'.repeat(64);
const LEDGER_PGID = 4242;
const MARKER_PGID = 5151;

const heldInspector = { markerState: async () => 'held' } as unknown as ProcessInspector;

const homeWithCompletedRow = async () => {
  const temp = await makeTempHome();
  await ensureMomongaDirs(temp.paths);
  const store = openRuntimeStore({ path: temp.paths.databases.runtime, home: temp.home, clock: createFakeClock(START_MS), leaseMs: 30_000, maxAttempts: 5, maxTotalAttempts: 20 });
  store.idempotency.begin(KEY, { expiresAt: START_MS + 60_000, meta: {} });
  store.idempotency.attachProcess(KEY, { pgid: LEDGER_PGID, startedAt: START_MS });
  store.idempotency.complete(KEY, { exitCode: 0 });
  return { temp, store };
};

const sweepOnce = async (event: 'startup' | 'sweep', temp: Awaited<ReturnType<typeof makeTempHome>>, store: ReturnType<typeof openRuntimeStore>) => {
  const calls: ReapMarkedProcessesOptions[] = [];
  const reap = async (options: ReapMarkedProcessesOptions) => {
    calls.push(options);
    return { removed: false };
  };
  await reapToolMarkers({ event, owners: createMarkerOwners(), inspector: heldInspector, dir: temp.paths.markers.tools, store, killGraceMs: 2000, onWarning: () => undefined, reap: reap as never });
  return calls;
};

describe.each(['startup', 'sweep'] as const)('the %s sweep reads the process group from the marker file only', (event) => {
  it.each([KEY, `hook-${'b'.repeat(32)}`, `evidence-${'c'.repeat(32)}`, `${KEY}-1`])('reaps the held marker %s through the group its marker file records', async (name) => {
    const { temp, store } = await homeWithCompletedRow();
    try {
      const marker = path.join(temp.paths.markers.tools, name);
      fs.writeFileSync(marker, '', { mode: 0o600 });
      await markerGroups.recordMarkerGroup(marker, MARKER_PGID);
      const calls = await sweepOnce(event, temp, store);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.marker).toBe(marker);
      expect(calls[0]?.pgid).toBe(MARKER_PGID);
    } finally {
      store.close();
    }
  });

  it('does not fall back to the ledger group when the marker file of a completed row records none', async () => {
    const { temp, store } = await homeWithCompletedRow();
    try {
      expect(store.idempotency.processGroupOf(KEY)).toBe(LEDGER_PGID);
      const marker = path.join(temp.paths.markers.tools, KEY);
      fs.writeFileSync(marker, '', { mode: 0o600 });
      const calls = await sweepOnce(event, temp, store);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.marker).toBe(marker);
      expect(calls[0]?.pgid).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
