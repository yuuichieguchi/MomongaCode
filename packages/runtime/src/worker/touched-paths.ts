import path from 'node:path';
import type { TouchedPath } from '@momonga/context';
import type { WorkingFacts } from '@momonga/protocol';

export const touchedPathsOf = (touched: WorkingFacts['touched'], cwd: string): TouchedPath[] => {
  const resolved = new Map<string, TouchedPath>();
  for (const target of touched) {
    const absolute = path.resolve(cwd, target.path ?? cwd);
    resolved.set(`${target.kind}:${absolute}`, { path: absolute, kind: target.kind });
  }
  return [...resolved.values()];
};
