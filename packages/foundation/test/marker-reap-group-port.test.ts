import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { groupAlive, hostProcessGroupPort, launchGroupLeader, recordMarkerGroup, reapMarkerDirectory } from '@momonga/foundation';
import type { ProcessGroupPort, SignalSender } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, TEST_UNPROTECTED_LAUNCH, killGroupsForCleanup, testProcessInspector } from '@momonga/testkit';
import { makeTemporaryDirectory } from './support/temporary-directory.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const MARKER_SLOT = 3;
const REAP_GRACE_MS = 200;
const STAY_ALIVE = 'setInterval(() => undefined, 1000);';

describe('the marker reap of a stale group signals through the group port it was given', () => {
  it('sends the stop of the group through the port and nothing through the host signal sender', async () => {
    const dir = makeTemporaryDirectory();
    const marker = path.join(dir, 'stale');
    fs.closeSync(fs.openSync(marker, 'w', 0o600));
    const launched = await launchGroupLeader({ file: process.execPath, args: ['-e', STAY_ALIVE], stdio: ['ignore', 'ignore', 'ignore'], protection: TEST_UNPROTECTED_LAUNCH.protection, marker: { slot: MARKER_SLOT, file: marker } });
    const pgid = launched.pgid;
    if (pgid === undefined) throw new Error('the stale group was not started');
    await recordMarkerGroup(marker, pgid);
    const host = hostProcessGroupPort();
    const portSignals: Array<[number, NodeJS.Signals]> = [];
    const port: ProcessGroupPort = {
      ...host,
      signal: async (group, signal, options) => {
        portSignals.push([group, signal]);
        return host.signal(group, signal, options);
      },
    };
    const hostSignals: number[] = [];
    const kill: SignalSender = (target) => {
      hostSignals.push(target);
    };
    try {
      await reapMarkerDirectory({ dir, killGraceMs: REAP_GRACE_MS, label: 'test', onWarning: () => undefined, kill, groupPort: port, signal: new AbortController().signal, inspector: testProcessInspector(), occasion: 'startup' });
      expect(portSignals).toContainEqual([pgid, 'SIGTERM']);
      expect(hostSignals).toEqual([]);
      expect(await groupAlive(pgid)).toBe(false);
    } finally {
      await killGroupsForCleanup([pgid]);
    }
  });
});
