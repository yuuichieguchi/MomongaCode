import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { groupAlive, hostProcessGroupPort } from '@momonga/foundation';
import type { ProcessGroupPort } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, REAL_PROCESS_WAIT_MS, pollUntil, TEST_UNPROTECTED_LAUNCH, killGroupsForCleanup, testProcessInspector } from '@momonga/testkit';
import { createGroupSpawn, reapStaleGroups } from '../src/managed/fm-processes.ts';
import { registerCleanup } from './gateway-helpers.ts';
import { MINIMAL_PATH, makeHome } from './gateway-process-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const REAP_GRACE_MS = 200;
const STAY_ALIVE = 'setInterval(() => undefined, 1000);';

const recordingPort = (asked: number[]): ProcessGroupPort => {
  const host = hostProcessGroupPort();
  return {
    ...host,
    alive: async (pgid, options) => {
      asked.push(pgid);
      return host.alive(pgid, options);
    },
    signal: async (pgid, signal, options) => {
      asked.push(pgid);
      await host.signal(pgid, signal, options);
    },
  };
};

describe('the start-up reap of stale managed server groups', () => {
  it('reads and stops a stale group through the group port it was given', async () => {
    const dir = makeHome();
    const markerDirectory = path.join(dir, 'markers');
    fs.mkdirSync(markerDirectory, { recursive: true });
    await createGroupSpawn({ inspector: testProcessInspector(), env: { PATH: MINIMAL_PATH, HOME: dir, TMPDIR: dir }, markerDirectory, onWarning: () => undefined })(process.execPath, ['-e', STAY_ALIVE], TEST_UNPROTECTED_LAUNCH.protection);
    const recordedGroup = (): number | undefined => {
      const marker = fs.readdirSync(markerDirectory)[0];
      const recorded = marker === undefined ? undefined : /g0*(\d+)/.exec(fs.readFileSync(path.join(markerDirectory, marker), 'utf8'))?.[1];
      return recorded === undefined ? undefined : Number(recorded);
    };
    await pollUntil(() => recordedGroup() !== undefined, { description: 'the marker to record the group of the server', boundMs: REAL_PROCESS_WAIT_MS });
    const pgid = recordedGroup();
    if (pgid === undefined) throw new Error('the marker lost its group record');
    registerCleanup(() => killGroupsForCleanup([pgid]));
    const asked: number[] = [];
    await reapStaleGroups({ markerDirectory, graceMs: REAP_GRACE_MS, onWarning: () => undefined, signal: new AbortController().signal, inspector: testProcessInspector(), port: recordingPort(asked) });
    expect(asked).toContain(pgid);
    expect(await groupAlive(pgid)).toBe(false);
  });
});
