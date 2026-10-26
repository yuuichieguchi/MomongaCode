import path from 'node:path';
import { comparableContains } from '@momonga/foundation';
import { alwaysWriteDenied, assertReadAllowedValid, canonicalizePath, defaultProtectedPaths } from '@momonga/sandbox';
import type { SandboxPolicy } from '@momonga/sandbox';
import { assertAbsoluteEntries } from '../read-access.ts';

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
  assertAbsoluteEntries('roots', options.roots);
  assertAbsoluteEntries('home', [options.home]);
  assertAbsoluteEntries('tmpDir', [options.tmpDir]);
  assertAbsoluteEntries('sessionsTmpRoot', [options.sessionsTmpRoot]);
  assertAbsoluteEntries('extraWritable', options.extraWritable ?? []);
  assertAbsoluteEntries('extraReadDenied', options.extraReadDenied ?? []);
  assertAbsoluteEntries('readAllowed', options.readAllowed ?? []);
  const denied = alwaysWriteDenied(options.home);
  const readDenied = [...denied.subtrees, options.sessionsTmpRoot, ...(options.extraReadDenied ?? [])];
  const readAllowed = unique([options.tmpDir, ...(options.readAllowed ?? [])]);
  const homeGuards = denied.subtrees.map(canonicalizePath);
  for (const entry of assertReadAllowedValid(readDenied, readAllowed)) {
    if (homeGuards.some((guard) => comparableContains(guard, entry))) throw new Error(`readAllowed entry must not lie inside ${denied.root} or ${denied.keychains}: ${entry}`);
  }
  return {
    writableRoots: [...options.roots, options.tmpDir, ...(options.extraWritable ?? [])],
    writeDenied: unique([...denied.subtrees, options.sessionsTmpRoot, ...protectedPathsFor(options.roots)]),
    writeDeniedLiterals: [...denied.literals],
    readDenied,
    readAllowed,
    network: options.network ?? 'deny',
  };
};
