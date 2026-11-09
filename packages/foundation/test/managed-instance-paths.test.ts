import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { managedInstancePaths, momongaPaths } from '@momonga/foundation';

type Instance = { owner: 'gateway'; generation: number; purpose: 'serve' | 'probe'; target: string } | { owner: 'cli'; purpose: 'serve' | 'probe'; target: string };

const placeOf = managedInstancePaths as unknown as (paths: ReturnType<typeof momongaPaths>, instance: Instance) => { socketPath: string; markerDirectory: string; lockPath: string };

const HOME = '/Users/someone';
const paths = momongaPaths(HOME, 'darwin', {});

const gateway = (generation: number, purpose: 'serve' | 'probe', target: string) => placeOf(paths, { owner: 'gateway', generation, purpose, target });
const cli = (purpose: 'serve' | 'probe', target: string) => placeOf(paths, { owner: 'cli', purpose, target });

describe.skipIf(process.platform === 'win32')('the one rule for the place of an instance (design-update-no-interrupt 18.2.1; design-managed-servers section 18, item 2)', () => {
  it.each([
    ['serve', 'apple'],
    ['probe', '_probe-apple'],
  ] as const)('places the gateway %s instance of generation N at run/g<N>/targets/<stem>.sock, its lock beside it, and markers/g<N>/targets/<stem>/', (purpose, stem) => {
    expect(gateway(3, purpose, 'apple')).toEqual({
      socketPath: path.join(paths.run, 'g3', 'targets', `${stem}.sock`),
      lockPath: path.join(paths.run, 'g3', 'targets', `${stem}.lock`),
      markerDirectory: path.join(paths.markers.root, 'g3', 'targets', stem),
    });
  });

  it.each([
    ['serve', '_cli-serve-apple'],
    ['probe', '_cli-probe-apple'],
  ] as const)('places the CLI %s instance outside every generation: run/<stem>.sock, run/<stem>.lock and markers/cli/<purpose>-<target>/', (purpose, stem) => {
    expect(cli(purpose, 'apple')).toEqual({
      socketPath: path.join(paths.run, `${stem}.sock`),
      lockPath: path.join(paths.run, `${stem}.lock`),
      markerDirectory: path.join(paths.markers.root, 'cli', `${purpose}-apple`),
    });
  });

  it('gives two generations of one target two instances that share no socket, lock or marker directory (18.2.2)', () => {
    const first = gateway(1, 'serve', 'apple');
    const second = gateway(2, 'serve', 'apple');
    expect(new Set([first.socketPath, second.socketPath]).size).toBe(2);
    expect(new Set([first.lockPath, second.lockPath]).size).toBe(2);
    expect(new Set([first.markerDirectory, second.markerDirectory]).size).toBe(2);
  });

  it('keeps a target named like a role file apart from the role sockets of its generation', () => {
    expect(gateway(1, 'serve', 'gateway').socketPath).not.toBe(path.join(paths.run, 'g1', 'gateway.sock'));
    expect(gateway(1, 'serve', 'gateway').lockPath).not.toBe(path.join(paths.run, 'g1', 'gateway.lock'));
  });

  it('recurs across starts: the same instance always gets the same place, so its start-time reap finds its orphans', () => {
    expect(gateway(4, 'probe', 'apple')).toEqual(gateway(4, 'probe', 'apple'));
    expect(cli('probe', 'apple')).toEqual(cli('probe', 'apple'));
  });
});
