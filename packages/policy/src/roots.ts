import { containsByComponents, everyAsync, someAsync } from '@momonga/foundation';
import type { PolicyPorts } from './filesystem.ts';
import { absoluteFrom } from './path-match.ts';

export type RootPorts = Pick<PolicyPorts, 'canonicalise' | 'locate'>;

const contains = async (ports: Pick<PolicyPorts, 'locate'>, directory: string, candidate: string): Promise<boolean> => {
  const located = await ports.locate(candidate);
  return containsByComponents((await ports.locate(directory)).parts, located.parts, located.caseInsensitive);
};

export const insideRoots = async (paths: readonly string[], roots: readonly string[], cwd: string, ports: RootPorts): Promise<boolean> => {
  if (paths.length === 0) return false;
  const canonicalRoots: string[] = [];
  for (const root of roots) {
    const resolution = await ports.canonicalise(absoluteFrom(root, cwd));
    if (resolution.ok) canonicalRoots.push(resolution.path);
  }
  return everyAsync(paths, async (target) => {
    const real = await ports.canonicalise(absoluteFrom(target, cwd));
    return real.ok && (await someAsync(canonicalRoots, (root) => contains(ports, root, real.path)));
  });
};
