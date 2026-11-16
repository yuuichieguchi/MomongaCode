import { spawnSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { generationLayout, momongaPaths, reapDeadGenerations } from '@momonga/foundation';
import { createTempDir, prepareGenerationForTest, removeTempDir, testKernelLock } from '@momonga/testkit';
import { healthAt } from '../src/daemon/ensure-daemon.ts';

const VERSION = '1.2.3';

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await removeTempDir(home);
});

const LISTEN_THEN_DIE = "require('node:net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'));";

const leaveDeadSocket = (socketPath: string): void => {
  const outcome = spawnSync(process.execPath, ['-e', LISTEN_THEN_DIE, socketPath], { stdio: 'ignore' });
  if (outcome.signal !== 'SIGKILL') throw new Error(`the listener of ${socketPath} did not die by SIGKILL: ${JSON.stringify({ status: outcome.status, signal: outcome.signal })}`);
  if (!fs.existsSync(socketPath)) throw new Error(`the dead listener left no socket at ${socketPath}`);
};

describe('T-L2-9 (14.4 last paragraph, LiveDialReachable): probeSupervisor during and after the removal of a dead generation', () => {
  it('answers no supervisor for the socket of a generation the reaper is removing, and again after it is gone', async () => {
    const home = createTempDir({ asHome: true });
    homes.push(home);
    const paths = momongaPaths(home, process.platform, {});
    fs.mkdirSync(paths.markers.root, { recursive: true, mode: 0o700 });
    prepareGenerationForTest(home, 1, VERSION);
    const dead = generationLayout(home, 1);
    leaveDeadSocket(dead.sockets.supervisor);
    const during: unknown[] = [];
    const result = await reapDeadGenerations({
      paths,
      lock: testKernelLock(),
      signal: new AbortController().signal,
      warn: () => undefined,
      reapMarkers: async () => {
        during.push(await healthAt(dead.sockets.supervisor));
      },
    });
    expect(result).toEqual({ removed: [1], kept: [], busy: false });
    expect(during.length).toBeGreaterThan(0);
    expect(during.every((health) => health === undefined)).toBe(true);
    expect(fs.existsSync(dead.sockets.supervisor)).toBe(false);
    await expect(healthAt(dead.sockets.supervisor)).resolves.toBeUndefined();
  });
});
