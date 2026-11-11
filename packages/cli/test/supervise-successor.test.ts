import { describe, expect, it } from 'vitest';
import { successorLauncherOf } from '../src/daemon/supervise.ts';
import type { DetachedExit, DetachedSpawn, SpawnDetached } from '../src/ports.ts';

const start = { home: '/people/a', env: { PATH: '/usr/bin', HOME: '/people/a' } };

describe('the launch of a successor generation by the supervise command', () => {
  it('starts the supervise command of the next generation apart, with the home and the environment of the running one', () => {
    const specs: DetachedSpawn[] = [];
    const spawnDetached: SpawnDetached = (spec) => {
      specs.push(spec);
      return { exit: new Promise<DetachedExit>(() => undefined) };
    };
    successorLauncherOf(start, { self: { kind: 'single-binary', execPath: '/opt/momonga/bin/momonga' }, spawnDetached }).launch(2);
    expect(specs).toEqual([{ command: '/opt/momonga/bin/momonga', args: ['__supervise', '--home=/people/a', '--generation=2', '--log-target=file'], env: start.env, cwd: '/people/a' }]);
  });

  it('hands the end of the spawned process to the supervisor, so that a spawn the host refuses after the launch returned is observed by it', async () => {
    const refused = Object.assign(new Error('spawn /opt/momonga/bin/momonga ENOENT'), { code: 'ENOENT' });
    const spawnDetached: SpawnDetached = () => ({ exit: Promise.reject(refused) });
    const launched = successorLauncherOf(start, { self: { kind: 'single-binary', execPath: '/opt/momonga/bin/momonga' }, spawnDetached }).launch(2);
    expect(launched.pid).toBeUndefined();
    await expect(launched.exit).rejects.toBe(refused);
  });
});
