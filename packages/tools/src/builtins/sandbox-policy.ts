import { comparableContains, momongaLayout } from '@momonga/foundation';
import type { FileRuleSet, ProtectedSet } from '@momonga/foundation';
import { SandboxPolicyError, alwaysWriteDenied, assertAbsoluteEntries, canonicalizePath, validateSandboxPolicy } from '@momonga/sandbox';
import type { SandboxPolicy } from '@momonga/sandbox';

export type SandboxPolicyOptions = {
  roots: readonly string[];
  home: string;
  tmpDir?: string;
  sessionsTmpRoot: string;
  fileRules: FileRuleSet;
  protectedSet: ProtectedSet;
  network?: 'deny' | 'allow';
  extraWritable?: readonly string[];
  extraReadDenied?: readonly string[];
  readAllowed?: readonly string[];
};

const unique = (values: readonly string[]): string[] => [...new Set(values)];

export const buildSandboxPolicy = (options: SandboxPolicyOptions): SandboxPolicy => {
  assertAbsoluteEntries('writable_root_not_absolute', 'roots', options.roots);
  assertAbsoluteEntries('entry_not_absolute', 'home', [options.home]);
  assertAbsoluteEntries('entry_not_absolute', 'tmpDir', options.tmpDir === undefined ? [] : [options.tmpDir]);
  assertAbsoluteEntries('entry_not_absolute', 'sessionsTmpRoot', [options.sessionsTmpRoot]);
  assertAbsoluteEntries('entry_not_absolute', 'extraWritable', options.extraWritable ?? []);
  assertAbsoluteEntries('entry_not_absolute', 'extraReadDenied', options.extraReadDenied ?? []);
  assertAbsoluteEntries('entry_not_absolute', 'readAllowed', options.readAllowed ?? []);
  const denied = alwaysWriteDenied(options.home);
  const readDenied = [...denied.readDenied, options.sessionsTmpRoot, ...(options.extraReadDenied ?? [])];
  const ownTmp = options.tmpDir === undefined ? [] : [options.tmpDir];
  const readAllowed = unique([...ownTmp, ...(options.readAllowed ?? [])]);
  const policy: SandboxPolicy = {
    writableRoots: [...options.roots, ...ownTmp, ...(options.extraWritable ?? [])],
    writeDenied: unique([...denied.subtrees, options.sessionsTmpRoot, ...options.protectedSet.paths]),
    writeDeniedLiterals: [...denied.literals],
    readDenied,
    readAllowed,
    network: options.network ?? 'deny',
    fileRules: options.fileRules,
    protectedSet: options.protectedSet,
  };
  validateSandboxPolicy(policy, options.tmpDir === undefined ? {} : { tmpDir: options.tmpDir });
  const homeGuards = denied.readDenied.map(canonicalizePath);
  const skillsRoot = canonicalizePath(momongaLayout(options.home).skills);
  for (const entry of readAllowed.map(canonicalizePath)) {
    if (homeGuards.some((guard) => comparableContains(guard, entry)) && !comparableContains(skillsRoot, entry)) {
      throw new SandboxPolicyError('read_allowed_inside_owned_root', `readAllowed entry must not lie inside ${denied.root} or ${denied.keychains}: ${entry}`, { path: entry });
    }
  }
  return policy;
};
