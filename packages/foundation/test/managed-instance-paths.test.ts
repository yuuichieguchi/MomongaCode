import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as foundation from '@momonga/foundation';
import { momongaPaths } from '@momonga/foundation';

type Instance = { owner: 'gateway' | 'cli'; purpose: 'serve' | 'probe'; target: string };
type InstancePaths = { socketPath: string; markerDirectory: string; lockPath: string };
type InstancePathsOf = (paths: ReturnType<typeof momongaPaths>, instance: Instance) => InstancePaths;

const managedInstancePaths: InstancePathsOf = (paths, instance) => {
  const value = (foundation as Record<string, unknown>)['managedInstancePaths'];
  if (value === undefined) throw new Error('@momonga/foundation does not export managedInstancePaths');
  return (value as InstancePathsOf)(paths, instance);
};

const HOME = '/Users/someone';
const paths = momongaPaths(HOME, 'darwin', {});

const inside = (dir: string, file: string): boolean => {
  const relative = path.relative(dir, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const of = (owner: Instance['owner'], purpose: Instance['purpose'], target: string): InstancePaths => managedInstancePaths(paths, { owner, purpose, target });

describe.skipIf(process.platform === 'win32')('a managed server instance is named by (owner, purpose, target) (design-managed-servers section 17, items 12, 13 and 19)', () => {
  it('names the gateway serving instance of a target by the target: socket <target>.sock and marker directory markers/targets/<target>', () => {
    const serving = of('gateway', 'serve', 'apple');
    expect(path.basename(serving.socketPath)).toBe('apple.sock');
    expect(serving.markerDirectory).toBe(path.join(paths.markers.targets, 'apple'));
  });

  it('gives two targets of one server kind two instances that share no socket, marker directory or lock', () => {
    const apple = of('gateway', 'serve', 'apple');
    const banana = of('gateway', 'serve', 'banana');
    expect(new Set([apple.socketPath, banana.socketPath]).size).toBe(2);
    expect(new Set([apple.markerDirectory, banana.markerDirectory]).size).toBe(2);
    expect(new Set([apple.lockPath, banana.lockPath]).size).toBe(2);
  });

  it('gives the gateway probe of a target its own instance under markers/targets, apart from the serving instance', () => {
    const serving = of('gateway', 'serve', 'apple');
    const probe = of('gateway', 'probe', 'apple');
    expect(inside(paths.markers.targets, probe.markerDirectory)).toBe(true);
    expect(probe.socketPath).not.toBe(serving.socketPath);
    expect(probe.markerDirectory).not.toBe(serving.markerDirectory);
    expect(inside(serving.markerDirectory, probe.markerDirectory) || inside(probe.markerDirectory, serving.markerDirectory)).toBe(false);
    expect(probe.lockPath).not.toBe(serving.lockPath);
  });

  it('puts the CLI probe of a target under the markers root but outside markers/targets, so the supervisor reap of a gone gateway never cuts it', () => {
    const cli = of('cli', 'probe', 'apple');
    expect(inside(paths.markers.root, cli.markerDirectory)).toBe(true);
    expect(inside(paths.markers.targets, cli.markerDirectory)).toBe(false);
    expect(cli.markerDirectory).not.toBe(paths.markers.targets);
  });

  it('gives the CLI probe one instance per target, not one socket for all targets', () => {
    const apple = of('cli', 'probe', 'apple');
    const banana = of('cli', 'probe', 'banana');
    expect(apple.socketPath).not.toBe(banana.socketPath);
    expect(apple.markerDirectory).not.toBe(banana.markerDirectory);
    expect(apple.socketPath).not.toBe(of('gateway', 'probe', 'apple').socketPath);
  });

  it('recurs across starts: the same instance always gets the same names, so its start-time reap finds its orphans', () => {
    expect(of('gateway', 'probe', 'apple')).toEqual(of('gateway', 'probe', 'apple'));
    expect(of('cli', 'probe', 'apple')).toEqual(of('cli', 'probe', 'apple'));
  });
});
