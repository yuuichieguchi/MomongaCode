import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureMomongaDirs } from '@momonga/foundation';
import type { ProcessInspector, ReapMarkedProcessesOptions } from '@momonga/foundation';
import { openRuntimeStore } from '@momonga/store';
import { createFakeClock } from '@momonga/testkit';
import { createMarkerOwners } from '@momonga/tools';
import { reapToolMarkers } from '../../src/process/tool-markers.ts';
import { START_MS, makeTempHome } from './helpers.ts';

const KEY = 'a'.repeat(64);
const RECORDED_PGID = 4242;

const heldInspector = { markerState: async () => 'held' } as unknown as ProcessInspector;

const completedCommandWithHeldMarker = async () => {
  const temp = await makeTempHome();
  await ensureMomongaDirs(temp.paths);
  const store = openRuntimeStore({ path: temp.paths.databases.runtime, home: temp.home, clock: createFakeClock(START_MS), leaseMs: 30_000, maxAttempts: 5, maxTotalAttempts: 20 });
  store.idempotency.begin(KEY, { expiresAt: START_MS + 60_000, meta: {} });
  store.idempotency.attachProcess(KEY, { pgid: RECORDED_PGID, startedAt: START_MS });
  store.idempotency.complete(KEY, { exitCode: 0 });
  const marker = path.join(temp.paths.markers.tools, KEY);
  fs.writeFileSync(marker, '', { mode: 0o600 });
  return { temp, store, marker };
};

describe.each(['startup', 'sweep'] as const)('the %s sweep reads the process group of a completed command as the guard does', (event) => {
  it('reaps the held marker of a completed row through the group the row recorded', async () => {
    const { temp, store, marker } = await completedCommandWithHeldMarker();
    try {
      expect(store.idempotency.get(KEY)?.s).toBe('COMPLETED');
      expect(store.idempotency.processGroupOf(KEY)).toBe(RECORDED_PGID);
      const calls: ReapMarkedProcessesOptions[] = [];
      const reap = async (options: ReapMarkedProcessesOptions) => {
        calls.push(options);
        return { removed: true };
      };

      await reapToolMarkers({ event, owners: createMarkerOwners(), inspector: heldInspector, dir: temp.paths.markers.tools, store, killGraceMs: 2000, onWarning: () => undefined, reap: reap as never });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.marker).toBe(marker);
      expect(calls[0]?.pgid).toBe(RECORDED_PGID);
    } finally {
      store.close();
    }
  });
});
