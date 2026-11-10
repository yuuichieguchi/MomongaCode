import path from 'node:path';
import { comparableContains, inWritableArea, lexicallyWithin, unresolvableReasonOf, writableAreaOf } from '@momonga/foundation';
import type { WritableArea } from '@momonga/foundation';
import type { Expression, FileMatcher, FileRuleEntry } from '@momonga/foundation';
import { SandboxPolicyError } from './policy-error.ts';
import { canonicalParentForm } from './always-write-denied.ts';
import { canonicalizePath } from './canonical-path.ts';
import type { SandboxPolicy } from './types.ts';

export interface SeatbeltProfile {
  profile: string;
  params: Record<string, string>;
}

function isWithin(candidate: string, root: string): boolean {
  return comparableContains(root, candidate);
}

function isStrictlyWithin(candidate: string, root: string): boolean {
  return isWithin(candidate, root) && !isWithin(root, candidate);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function guardCandidateInside(area: WritableArea, candidate: string, mode: 'canonical' | 'lexical'): boolean {
  try {
    return inWritableArea(area, candidate, mode);
  } catch (error) {
    const reason = unresolvableReasonOf(error);
    if (reason === undefined) throw error;
    throw new SandboxPolicyError('guard_path_unresolvable', `cannot decide whether ${candidate} lies in the writable area`, { path: candidate, reason, cause: error });
  }
}

function ancestorsWithin(target: string, area: WritableArea, mode: 'canonical' | 'lexical', includeTarget = false): string[] {
  const found: string[] = [];
  for (let current = includeTarget ? target : path.dirname(target); current !== path.dirname(current); current = path.dirname(current)) {
    if (guardCandidateInside(area, current, mode)) found.push(current);
  }
  return found;
}

export function assertAbsoluteEntries(code: 'entry_not_absolute' | 'writable_root_not_absolute', field: string, entries: readonly string[]): void {
  for (const entry of entries) {
    if (!path.isAbsolute(entry)) throw new SandboxPolicyError(code, `${field} entry must be an absolute path: ${entry}`, { path: entry });
  }
}

function assertReadAllowedValid(readDenied: readonly string[], readAllowed: readonly string[]): string[] {
  const denied = unique(readDenied.map(canonicalizePath));
  return unique(readAllowed.map(canonicalizePath)).map((entry) => {
    if (!denied.some((guard) => isStrictlyWithin(entry, guard))) {
      throw new SandboxPolicyError('read_allowed_not_inside_denied', `readAllowed entry must lie strictly inside a readDenied entry: ${entry}`, { path: entry });
    }
    if (denied.some((guard) => isWithin(guard, entry))) {
      throw new SandboxPolicyError('read_allowed_contains_denied', `readAllowed entry must not equal or contain a readDenied entry: ${entry}`, { path: entry });
    }
    return entry;
  });
}

function assertSessionTmpDirValid(policy: SandboxPolicy, tmpDir: string): string {
  const canonical = canonicalizePath(tmpDir);
  const readAllowed = (policy.readAllowed ?? []).map(canonicalizePath);
  if (!readAllowed.some((entry) => isWithin(canonical, entry) && isWithin(entry, canonical))) {
    throw new SandboxPolicyError('session_tmp_not_read_allowed', `session tmpDir must be one of the readAllowed entries: ${canonical}`, { path: canonical });
  }
  if (policy.writeDenied.map(canonicalizePath).some((entry) => isWithin(entry, canonical))) {
    throw new SandboxPolicyError('session_tmp_write_denied', `session tmpDir must not equal or contain a writeDenied entry: ${canonical}`, { path: canonical });
  }
  return canonical;
}

export function validateSandboxPolicy(policy: SandboxPolicy, options: { tmpDir?: string } = {}): void {
  assertAbsoluteEntries('writable_root_not_absolute', 'writableRoots', policy.writableRoots);
  assertAbsoluteEntries('entry_not_absolute', 'writeDenied', policy.writeDenied);
  assertAbsoluteEntries('entry_not_absolute', 'writeDeniedLiterals', policy.writeDeniedLiterals);
  assertAbsoluteEntries('entry_not_absolute', 'protectedSet.literals', policy.protectedSet.literals);
  assertAbsoluteEntries('entry_not_absolute', 'readDenied', policy.readDenied);
  assertAbsoluteEntries('entry_not_absolute', 'readAllowed', policy.readAllowed ?? []);
  assertAbsoluteEntries('entry_not_absolute', 'unixSocketAllow', policy.unixSocketAllow ?? []);
  assertReadAllowedValid(policy.readDenied, policy.readAllowed ?? []);
  if (options.tmpDir !== undefined) assertSessionTmpDirValid(policy, options.tmpDir);
}

function metadataAncestors(
  allowed: readonly string[],
  denied: readonly string[],
  within: (candidate: string, root: string) => boolean = isWithin,
): string[] {
  const strictlyWithin = (candidate: string, root: string): boolean => within(candidate, root) && !within(root, candidate);
  const found: string[] = [];
  for (const entry of allowed) {
    for (const guard of denied.filter((candidate) => strictlyWithin(entry, candidate))) {
      for (let current = path.dirname(entry); within(current, guard); current = path.dirname(current)) {
        found.push(current);
        if (within(guard, current)) break;
      }
    }
  }
  return unique(found);
}

const DEVICE_NODE_RULES = [
  '(allow file-write-data (literal "/dev/null") (literal "/dev/dtracehelper"))',
  '(allow file-write-data file-ioctl (literal "/dev/tty"))',
  '(allow file-write-data file-ioctl (regex #"^/dev/fd/[0-9]+$"))',
];

const BASE_RULES = [
  '(version 1)',
  '(deny default)',
  '(allow process-exec)',
  '(allow process-fork)',
  '(allow sysctl-read)',
  '(allow mach-lookup (global-name "com.apple.bsd.dirhelper") (global-name "com.apple.system.opendirectoryd.libinfo"))',
  '(allow system-sched (target self))',
  '(allow sysctl-write (sysctl-name "vfs.nspace.prevent_materialization"))',
  '(allow signal (target same-sandbox))',
  '(allow file-read*)',
  ...DEVICE_NODE_RULES,
];

type Terms = readonly string[];

type DenyForm = { matcher: FileMatcher; directory: string };

const expressionTerm = (expression: Expression, param: (value: string) => string): string | undefined => {
  switch (expression.kind) {
    case 'none':
      return undefined;
    case 'subpath':
      return `(subpath (param "${param(expression.path)}"))`;
    case 'regex':
      return `(regex (param "${param(expression.source)}"))`;
  }
};

const asExpression = (terms: Terms): string => (terms.length === 1 ? (terms[0] as string) : `(require-all ${terms.join(' ')})`);

const isUserDeny = (entry: FileRuleEntry): boolean =>
  entry.effect === 'deny' && entry.unresolved === null && (entry.tool === 'Read' || entry.tool === 'Edit');

const denyFormsOf = (entry: FileRuleEntry): DenyForm[] => [
  { matcher: entry.deny, directory: entry.anchorDirectory },
  ...(entry.denyLexical === null ? [] : [{ matcher: entry.denyLexical, directory: entry.lexicalDirectory }]),
];

export function buildSeatbeltProfile(policy: SandboxPolicy, options: { tmpDir?: string; scratchDir?: string } = {}): SeatbeltProfile {
  validateSandboxPolicy(policy, options.tmpDir === undefined ? {} : { tmpDir: options.tmpDir });
  const roots = unique(policy.writableRoots.map(canonicalizePath));
  const writeDenied = unique(policy.writeDenied.map(canonicalizePath));
  const readDenied = unique(policy.readDenied.map(canonicalizePath));
  const readAllowed = unique((policy.readAllowed ?? []).map(canonicalizePath));
  const sessionTmpDir = options.tmpDir === undefined ? undefined : canonicalizePath(options.tmpDir);
  const scratchDir = options.scratchDir === undefined ? undefined : canonicalizePath(options.scratchDir);
  const area = writableAreaOf({ writableRoots: roots, entries: policy.fileRules.entries });
  const literals = unique([...policy.writeDeniedLiterals, ...policy.protectedSet.literals]);
  const literalForms = unique(literals.flatMap((literal) => [literal, canonicalParentForm(literal)]));
  const literalAncestors = unique(literalForms.flatMap((target) => ancestorsWithin(target, area, 'canonical')));
  const userDenies = [...policy.fileRules.entries, ...policy.protectedSet.patterns.entries].filter(isUserDeny);
  const userAncestors = unique(
    userDenies.flatMap((entry) =>
      denyFormsOf(entry).flatMap(({ matcher, directory }) => ancestorsWithin(directory, area, 'lexical', matcher.own.kind !== 'subpath')),
    ),
  );
  const userReadGuards = unique(userDenies.filter((entry) => entry.access === 'read').flatMap((entry) => denyFormsOf(entry).map(({ directory }) => directory)));
  const guardedAncestors = unique([...writeDenied.flatMap((target) => ancestorsWithin(target, area, 'canonical')), ...literalAncestors, ...userAncestors]);
  const symlinkGuarded = unique([...literalAncestors, ...userAncestors]);
  const metadataAllowed = [...readAllowed, ...(userDenies.length > 0 && scratchDir !== undefined ? [scratchDir] : [])];
  const reallowedScratch = [...(sessionTmpDir === undefined ? [] : [sessionTmpDir]), ...(scratchDir === undefined ? [] : [scratchDir])];
  const metadataOf = (allowed: readonly string[]): string[] =>
    unique([...metadataAncestors(allowed, readDenied), ...metadataAncestors(allowed, userReadGuards, lexicallyWithin)]);
  const reallowedMetadata = metadataOf(reallowedScratch);
  const metadataDirs = unique([...metadataOf(metadataAllowed), ...reallowedMetadata]);

  const params: Record<string, string> = {};
  const counters = new Map<string, number>();
  const lines = [...BASE_RULES];
  const define = (prefix: string, values: readonly string[]): string[] =>
    values.map((value, index) => {
      const name = `${prefix}_${index}`;
      params[name] = value;
      return name;
    });
  const next = (prefix: string, value: string): string => {
    const index = counters.get(prefix) ?? 0;
    counters.set(prefix, index + 1);
    const name = `${prefix}_${index}`;
    params[name] = value;
    return name;
  };

  for (const name of define('WRITABLE_ROOT', roots)) lines.push(`(allow file-write* (subpath (param "${name}")))`);
  for (const entry of policy.fileRules.entries) {
    if (!entry.widening) continue;
    const term = expressionTerm(entry.subset.closure, (value) => next('FILE_ALLOW_WRITE', value));
    if (term !== undefined) lines.push(`(allow file-write* ${term})`);
  }
  for (const name of define('WRITE_DENIED', writeDenied)) lines.push(`(deny file-write* (subpath (param "${name}")))`);
  const sessionTmpNames = sessionTmpDir === undefined ? [] : define('SESSION_TMP', [sessionTmpDir]);
  for (const name of sessionTmpNames) lines.push(`(allow file-write* (subpath (param "${name}")))`);
  for (const name of define('WRITE_DENIED_LITERAL', literals)) lines.push(`(deny file-write* (literal (param "${name}")))`);
  for (const name of define('GUARDED_ANCESTOR', guardedAncestors)) {
    lines.push(`(deny file-write-unlink (literal (param "${name}")))`);
  }
  for (const name of define('SYMLINK_GUARD', symlinkGuarded)) {
    lines.push(`(deny file-write-create (require-all (literal (param "${name}")) (vnode-type SYMLINK)))`);
  }
  const readDeniedNames = define('READ_DENIED', readDenied);
  for (const name of readDeniedNames) lines.push(`(deny file-read* (subpath (param "${name}")))`);
  const readAllowedNames = define('READ_ALLOWED', readAllowed);
  for (const name of readAllowedNames) lines.push(`(allow file-read* (subpath (param "${name}")))`);
  const metadataNames = define('READ_METADATA', metadataDirs);
  for (const name of metadataNames) lines.push(`(allow file-read-metadata (literal (param "${name}")))`);

  if (userDenies.length > 0) {
    const guards: Terms[] = [];
    for (const entry of userDenies) {
      const prefix = entry.access === 'read' ? 'FILE_DENY_READ' : 'FILE_DENY_WRITE';
      const operations = entry.access === 'read' ? 'file-read* file-write-unlink' : 'file-write*';
      const param = (value: string): string => next(prefix, value);
      for (const { matcher } of denyFormsOf(entry)) {
        const carved = entry.exceptions.length > 0 && !entry.blockedAsWhole;
        const formTerms: Terms[] = [];
        if (!carved) {
          const closure = expressionTerm(matcher.closure, param);
          if (closure !== undefined) formTerms.push([closure]);
        } else {
          const own = expressionTerm(matcher.own, param);
          if (own !== undefined) {
            const exceptions = entry.exceptions.flatMap((exception) => {
              const term = expressionTerm(exception.subset.own, (value) => next('FILE_EXCEPTION', value));
              return term === undefined ? [] : [`(require-not ${term})`];
            });
            formTerms.push([own, ...exceptions]);
          }
          const below = expressionTerm(matcher.below, param);
          if (below !== undefined) formTerms.push([below]);
        }
        for (const terms of formTerms) {
          lines.push(`(deny ${operations} ${asExpression(terms)})`);
          if (entry.access === 'write') guards.push(terms);
        }
      }
    }
    for (const terms of guards) lines.push(`(deny file-read-metadata (require-all ${[...terms, '(vnode-type SYMLINK)'].join(' ')}))`);
    for (const name of sessionTmpNames) lines.push(`(allow file-write* (subpath (param "${name}")))`);
    const sessionTmpIndex = sessionTmpDir === undefined ? -1 : readAllowed.findIndex((entry) => isWithin(sessionTmpDir, entry) && isWithin(entry, sessionTmpDir));
    if (sessionTmpIndex >= 0) lines.push(`(allow file-read* (subpath (param "${readAllowedNames[sessionTmpIndex]}")))`);
    if (scratchDir !== undefined) {
      for (const name of define('PRIVATE_TMP', [scratchDir])) {
        lines.push(`(allow file-write* (subpath (param "${name}")))`, `(allow file-read* (subpath (param "${name}")))`);
      }
    }
    for (const directory of reallowedMetadata) lines.push(`(allow file-read-metadata (literal (param "${metadataNames[metadataDirs.indexOf(directory)]}")))`);
    lines.push(...DEVICE_NODE_RULES);
  }
  const unixSocketAllow = unique((policy.unixSocketAllow ?? []).map(canonicalizePath));
  if (policy.network === 'allow') lines.push('(allow network*)');
  for (const name of define('UNIX_SOCKET_ALLOW', unixSocketAllow)) {
    lines.push(`(allow network-outbound (remote unix-socket (subpath (param "${name}"))))`);
  }
  if (policy.network === 'allow' || unixSocketAllow.length > 0) {
    for (const name of readDeniedNames) {
      lines.push(`(deny network-outbound (remote unix-socket (subpath (param "${name}"))))`);
    }
  }

  return { profile: `${lines.join('\n')}\n`, params };
}
