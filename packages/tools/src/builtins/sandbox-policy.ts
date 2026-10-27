import { comparableContains } from '@momonga/foundation';
import type { FileRuleSet } from '@momonga/foundation';
import { SandboxPolicyError, alwaysWriteDenied, assertAbsoluteEntries, canonicalizePath, defaultProtectedPaths, validateSandboxPolicy } from '@momonga/sandbox';
import type { SandboxPolicy } from '@momonga/sandbox';

export const protectedPathsFor = (roots: readonly string[]): string[] => roots.flatMap(defaultProtectedPaths);

export type SandboxPolicyOptions = {
  roots: readonly string[];
  home: string;
  tmpDir: string;
  sessionsTmpRoot: string;
  fileRules: FileRuleSet;
  network?: 'deny' | 'allow';
  extraWritable?: readonly string[];
  extraReadDenied?: readonly string[];
  readAllowed?: readonly string[];
};

const unique = (values: readonly string[]): string[] => [...new Set(values)];

export const buildSandboxPolicy = (options: SandboxPolicyOptions): SandboxPolicy => {
  assertAbsoluteEntries('writable_root_not_absolute', 'roots', options.roots);
  assertAbsoluteEntries('entry_not_absolute', 'home', [options.home]);
  assertAbsoluteEntries('entry_not_absolute', 'tmpDir', [options.tmpDir]);
  assertAbsoluteEntries('entry_not_absolute', 'sessionsTmpRoot', [options.sessionsTmpRoot]);
  assertAbsoluteEntries('entry_not_absolute', 'extraWritable', options.extraWritable ?? []);
  assertAbsoluteEntries('entry_not_absolute', 'extraReadDenied', options.extraReadDenied ?? []);
  assertAbsoluteEntries('entry_not_absolute', 'readAllowed', options.readAllowed ?? []);
  const denied = alwaysWriteDenied(options.home);
  const readDenied = [...denied.subtrees, options.sessionsTmpRoot, ...(options.extraReadDenied ?? [])];
  const readAllowed = unique([options.tmpDir, ...(options.readAllowed ?? [])]);
  const policy: SandboxPolicy = {
    writableRoots: [...options.roots, options.tmpDir, ...(options.extraWritable ?? [])],
    writeDenied: unique([...denied.subtrees, options.sessionsTmpRoot, ...protectedPathsFor(options.roots)]),
    writeDeniedLiterals: [...denied.literals],
    readDenied,
    readAllowed,
    network: options.network ?? 'deny',
    fileRules: options.fileRules,
  };
  validateSandboxPolicy(policy, { tmpDir: options.tmpDir });
  const homeGuards = denied.subtrees.map(canonicalizePath);
  for (const entry of readAllowed.map(canonicalizePath)) {
    if (homeGuards.some((guard) => comparableContains(guard, entry))) {
      throw new SandboxPolicyError('read_allowed_inside_owned_root', `readAllowed entry must not lie inside ${denied.root} or ${denied.keychains}: ${entry}`, { path: entry });
    }
  }
  return policy;
};
