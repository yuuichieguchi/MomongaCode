import { hostPaths, mapAsync, someAsync } from '@momonga/foundation';
import type { FileRuleSet, MomongaPaths, ProtectedSet } from '@momonga/foundation';
import { SandboxPolicyError, alwaysWriteDenied, assertAbsoluteEntries, validateSandboxPolicy } from '@momonga/sandbox';
import type { OwnedLayout, SandboxPolicy } from '@momonga/sandbox';

export type SandboxPolicyOptions = {
  roots: readonly string[];
  home: string;
  layout: OwnedLayout & Pick<MomongaPaths, 'skills'>;
  tmpDir?: string;
  sessionsTmpRoot: string;
  fileRules: FileRuleSet;
  protectedSet: ProtectedSet;
  network?: 'deny' | 'allow';
  extraWritable?: readonly string[];
  extraReadDenied?: readonly string[];
  readAllowed?: readonly string[];
  unixSocketAllow?: readonly string[];
};

const unique = (values: readonly string[]): string[] => [...new Set(values)];

export const buildSandboxPolicy = async (options: SandboxPolicyOptions, signal: AbortSignal): Promise<SandboxPolicy> => {
  const paths = hostPaths(signal);
  assertAbsoluteEntries('writable_root_not_absolute', 'roots', options.roots);
  assertAbsoluteEntries('entry_not_absolute', 'home', [options.home]);
  assertAbsoluteEntries('entry_not_absolute', 'tmpDir', options.tmpDir === undefined ? [] : [options.tmpDir]);
  assertAbsoluteEntries('entry_not_absolute', 'sessionsTmpRoot', [options.sessionsTmpRoot]);
  assertAbsoluteEntries('entry_not_absolute', 'extraWritable', options.extraWritable ?? []);
  assertAbsoluteEntries('entry_not_absolute', 'extraReadDenied', options.extraReadDenied ?? []);
  assertAbsoluteEntries('entry_not_absolute', 'readAllowed', options.readAllowed ?? []);
  const denied = await alwaysWriteDenied(options.layout, signal);
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
    unixSocketAllow: unique(options.unixSocketAllow ?? []),
    fileRules: options.fileRules,
    protectedSet: options.protectedSet,
  };
  await validateSandboxPolicy(policy, options.tmpDir === undefined ? {} : { tmpDir: options.tmpDir }, paths);
  const homeGuards = await mapAsync(denied.readDenied, paths.canonicalPath);
  const skillsRoot = await paths.canonicalPath(options.layout.skills);
  for (const entry of await mapAsync(readAllowed, paths.canonicalPath)) {
    if ((await someAsync(homeGuards, (guard) => paths.comparableContains(guard, entry))) && !(await paths.comparableContains(skillsRoot, entry))) {
      throw new SandboxPolicyError('read_allowed_inside_owned_root', `readAllowed entry must not lie inside ${denied.root} or ${denied.keychains}: ${entry}`, { path: entry });
    }
  }
  return policy;
};
