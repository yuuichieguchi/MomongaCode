import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as foundation from '@momonga/foundation';
import { momongaLayout } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';

type GenerationScope = (paths: MomongaPaths, generation: number) => MomongaPaths;
type GenerationFiles = { current: string; generationLock: string };

const HOME = '/home/user';

const scopeToGeneration = (): GenerationScope => {
  const value = (foundation as Record<string, unknown>)['scopeToGeneration'];
  if (typeof value !== 'function') throw new Error('@momonga/foundation does not export scopeToGeneration');
  return value as GenerationScope;
};

const isInside = (child: string, parent: string): boolean => {
  const relative = path.posix.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.posix.isAbsolute(relative);
};

const cliSources = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return cliSources(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });

describe('H4: locks, sockets, markers and call locks are generation-scoped', () => {
  const base = momongaLayout(HOME, 'darwin', {});

  it('puts the sockets and locks of generation N under run/g<N>/', () => {
    const third = scopeToGeneration()(base, 3);
    expect(third.sockets).toEqual({
      gateway: '/home/user/.momonga/run/g3/gateway.sock',
      runtime: '/home/user/.momonga/run/g3/runtime.sock',
      supervisor: '/home/user/.momonga/run/g3/supervisor.sock',
    });
    expect(third.locks).toEqual({
      gateway: '/home/user/.momonga/run/g3/gateway.lock',
      runtime: '/home/user/.momonga/run/g3/runtime.lock',
      supervisor: '/home/user/.momonga/run/g3/supervisor.lock',
    });
  });

  it('keeps run/current and run/generation.lock as the only unscoped run files', () => {
    const files = (base as MomongaPaths & { generations?: GenerationFiles }).generations;
    expect(files).toEqual({ current: '/home/user/.momonga/run/current', generationLock: '/home/user/.momonga/run/generation.lock' });
  });

  it('gives two generations disjoint marker, call-lock and spawn tmp directories', () => {
    const scope = scopeToGeneration();
    const first = scope(base, 1);
    const second = scope(base, 2);
    const scoped = (paths: MomongaPaths): string[] => [
      paths.callLocks,
      paths.markers.root,
      paths.markers.tools,
      paths.markers.mcp,
      paths.markers.targets,
      paths.markers.daemons,
      paths.tmp.spawn,
    ];
    for (const [one, other] of scoped(first).map((directory, index) => [directory, scoped(second)[index] as string] as const)) {
      expect(one).not.toBe(other);
      expect(isInside(one, other)).toBe(false);
      expect(isInside(other, one)).toBe(false);
    }
    for (const directory of [...scoped(first), ...scoped(second)]) {
      expect(directory).not.toBe(base.markers.root);
      expect(directory).not.toBe(base.callLocks);
    }
    expect(isInside(first.markers.tools, first.markers.root)).toBe(true);
    expect(isInside(second.markers.mcp, second.markers.root)).toBe(true);
  });

  it('keeps the store, settings and probe records shared by every generation', () => {
    const second = scopeToGeneration()(base, 2);
    expect(second.databases).toEqual(base.databases);
    expect(second.settingsFile).toBe(base.settingsFile);
    expect(second.probe).toBe(base.probe);
    expect(second.root).toBe(base.root);
  });

  it('leaves at most one CLI module that reads the daemon socket paths, the resolver', () => {
    const cliSource = path.resolve(import.meta.dirname, '../../../cli/src');
    const readers = cliSources(cliSource).filter((file) => /\.sockets\.(gateway|runtime|supervisor)\b/.test(fs.readFileSync(file, 'utf8')));
    const names = readers.map((file) => path.relative(cliSource, file)).sort();
    expect(names.length, names.join(', ')).toBeLessThanOrEqual(1);
  });
});
