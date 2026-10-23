import path from 'node:path';
import { comparableContains } from '@momonga/foundation';
import { assertReadAllowedValid, canonicalizePath, defaultProtectedPaths } from '@momonga/sandbox';
import type { SandboxPolicy } from '@momonga/sandbox';

export const protectedPathsFor = (roots: readonly string[]): string[] => roots.flatMap(defaultProtectedPaths);

export type SandboxPolicyOptions = {
  roots: readonly string[];
  home: string;
  tmpDir: string;
  sessionsTmpRoot: string;
  network?: 'deny' | 'allow';
  extraWritable?: readonly string[];
  extraReadDenied?: readonly string[];
  readAllowed?: readonly string[];
};

const unique = (values: readonly string[]): string[] => [...new Set(values)];

export const buildSandboxPolicy = (options: SandboxPolicyOptions): SandboxPolicy => {
  const momonga = path.join(options.home, '.momonga');
  const keychains = path.join(options.home, 'Library', 'Keychains');
  const readDenied = [momonga, keychains, options.sessionsTmpRoot, ...(options.extraReadDenied ?? [])];
  const readAllowed = unique([options.tmpDir, ...(options.readAllowed ?? [])]);
  const homeGuards = [momonga, keychains].map(canonicalizePath);
  for (const entry of assertReadAllowedValid(readDenied, readAllowed)) {
    if (homeGuards.some((guard) => comparableContains(guard, entry))) throw new Error(`readAllowed entry must not lie inside ${momonga} or ${keychains}: ${entry}`);
  }
  return {
    writableRoots: [...options.roots, options.tmpDir, ...(options.extraWritable ?? [])],
    writeDenied: unique([momonga, keychains, options.sessionsTmpRoot, ...protectedPathsFor(options.roots)]),
    readDenied,
    readAllowed,
    network: options.network ?? 'deny',
  };
};
