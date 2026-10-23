import path from 'node:path';
import { defaultProtectedPaths } from '@momonga/sandbox';
import type { SandboxPolicy } from '@momonga/sandbox';

export const protectedPathsFor = (roots: readonly string[]): string[] => roots.flatMap(defaultProtectedPaths);

export type SandboxPolicyOptions = {
  roots: readonly string[];
  home: string;
  tmpDir: string;
  network?: 'deny' | 'allow';
  extraWritable?: readonly string[];
  extraReadDenied?: readonly string[];
};

export const buildSandboxPolicy = (options: SandboxPolicyOptions): SandboxPolicy => ({
  writableRoots: [...options.roots, options.tmpDir, ...(options.extraWritable ?? [])],
  writeDenied: protectedPathsFor(options.roots),
  readDenied: [path.join(options.home, '.momonga'), path.join(options.home, 'Library', 'Keychains'), ...(options.extraReadDenied ?? [])],
  network: options.network ?? 'deny',
});
