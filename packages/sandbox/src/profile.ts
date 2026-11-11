import path from 'node:path';
import { filterAsync, findAsync, inWritableArea, lexicallyWithin, mapAsync, someAsync, unresolvableReasonOf, writableAreaOf } from '@momonga/foundation';
import type { Awaitable, PathResolver, WritableArea } from '@momonga/foundation';
import type { Expression, FileMatcher, FileRuleEntry } from '@momonga/foundation';
import { SandboxPolicyError } from './policy-error.ts';
import { canonicalParentForm } from './always-write-denied.ts';
import type { SandboxPolicy } from './types.ts';

export interface SeatbeltProfile {
  profile: string;
  params: Record<string, string>;
}

const HIGHEST_PORT = 65_535;

export const assertLoopbackPort = (loopbackPort: number): number => {
  if (!Number.isInteger(loopbackPort) || loopbackPort < 1 || loopbackPort > HIGHEST_PORT) {
    throw new SandboxPolicyError('network_port_invalid', `network.loopbackPort must be a port number: ${String(loopbackPort)}`);
  }
  return loopbackPort;
};

export const paramArgsOf = (params: Record<string, string>): string[] => Object.entries(params).flatMap(([name, value]) => ['-D', `${name}=${value}`]);

type Within = (candidate: string, root: string) => Awaitable<boolean>;

const withinOf =
  (paths: PathResolver): Within =>
  (candidate, root) =>
    paths.comparableContains(root, candidate);

const strictlyWithin = async (within: Within, candidate: string, root: string): Promise<boolean> => (await within(candidate, root)) && !(await within(root, candidate));

const sameLocation = async (within: Within, left: string, right: string): Promise<boolean> => (await within(left, right)) && (await within(right, left));

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

async function guardCandidateInside(area: WritableArea, candidate: string, mode: 'canonical' | 'lexical', paths: PathResolver): Promise<boolean> {
  try {
    return await inWritableArea(area, candidate, mode, paths);
  } catch (error) {
    const reason = unresolvableReasonOf(error);
    if (reason === undefined) throw error;
    throw new SandboxPolicyError('guard_path_unresolvable', `cannot decide whether ${candidate} lies in the writable area`, { path: candidate, reason, cause: error });
  }
}

async function ancestorsWithin(target: string, area: WritableArea, mode: 'canonical' | 'lexical', paths: PathResolver, includeTarget = false): Promise<string[]> {
  const found: string[] = [];
  for (let current = includeTarget ? target : path.dirname(target); current !== path.dirname(current); current = path.dirname(current)) {
    if (await guardCandidateInside(area, current, mode, paths)) found.push(current);
  }
  return found;
}

const flatMapAsync = async <T, R>(items: readonly T[], convert: (item: T) => Awaitable<readonly R[]>): Promise<R[]> => (await mapAsync(items, convert)).flat();

export function assertAbsoluteEntries(code: 'entry_not_absolute' | 'writable_root_not_absolute', field: string, entries: readonly string[]): void {
  for (const entry of entries) {
    if (!path.isAbsolute(entry)) throw new SandboxPolicyError(code, `${field} entry must be an absolute path: ${entry}`, { path: entry });
  }
}

async function assertReadAllowedValid(readDenied: readonly string[], readAllowed: readonly string[], paths: PathResolver): Promise<string[]> {
  const within = withinOf(paths);
  const denied = unique(await mapAsync(readDenied, paths.canonicalPath));
  return mapAsync(unique(await mapAsync(readAllowed, paths.canonicalPath)), async (entry) => {
    if (!(await someAsync(denied, (guard) => strictlyWithin(within, entry, guard)))) {
      throw new SandboxPolicyError('read_allowed_not_inside_denied', `readAllowed entry must lie strictly inside a readDenied entry: ${entry}`, { path: entry });
    }
    if (await someAsync(denied, (guard) => within(guard, entry))) {
      throw new SandboxPolicyError('read_allowed_contains_denied', `readAllowed entry must not equal or contain a readDenied entry: ${entry}`, { path: entry });
    }
    return entry;
  });
}

async function assertSessionTmpDirValid(policy: SandboxPolicy, tmpDir: string, paths: PathResolver): Promise<string> {
  const within = withinOf(paths);
  const canonical = await paths.canonicalPath(tmpDir);
  const readAllowed = await mapAsync(policy.readAllowed ?? [], paths.canonicalPath);
  if (!(await someAsync(readAllowed, (entry) => sameLocation(within, canonical, entry)))) {
    throw new SandboxPolicyError('session_tmp_not_read_allowed', `session tmpDir must be one of the readAllowed entries: ${canonical}`, { path: canonical });
  }
  if (await someAsync(await mapAsync(policy.writeDenied, paths.canonicalPath), (entry) => within(entry, canonical))) {
    throw new SandboxPolicyError('session_tmp_write_denied', `session tmpDir must not equal or contain a writeDenied entry: ${canonical}`, { path: canonical });
  }
  return canonical;
}

export async function validateSandboxPolicy(policy: SandboxPolicy, options: { tmpDir?: string }, paths: PathResolver): Promise<void> {
  assertAbsoluteEntries('writable_root_not_absolute', 'writableRoots', policy.writableRoots);
  assertAbsoluteEntries('entry_not_absolute', 'writeDenied', policy.writeDenied);
  assertAbsoluteEntries('entry_not_absolute', 'writeDeniedLiterals', policy.writeDeniedLiterals);
  assertAbsoluteEntries('entry_not_absolute', 'protectedSet.literals', policy.protectedSet.literals);
  assertAbsoluteEntries('entry_not_absolute', 'readDenied', policy.readDenied);
  assertAbsoluteEntries('entry_not_absolute', 'readAllowed', policy.readAllowed ?? []);
  assertAbsoluteEntries('entry_not_absolute', 'unixSocketAllow', policy.unixSocketAllow ?? []);
  await assertReadAllowedValid(policy.readDenied, policy.readAllowed ?? [], paths);
  if (options.tmpDir !== undefined) await assertSessionTmpDirValid(policy, options.tmpDir, paths);
}

async function metadataAncestors(allowed: readonly string[], denied: readonly string[], within: Within): Promise<string[]> {
  const found: string[] = [];
  for (const entry of allowed) {
    for (const guard of await filterAsync(denied, (candidate) => strictlyWithin(within, entry, candidate))) {
      for (let current = path.dirname(entry); await within(current, guard); current = path.dirname(current)) {
        found.push(current);
        if (await within(guard, current)) break;
      }
    }
  }
  return unique(found);
}

export const SYSTEM_RESOLVER_SOCKET = '/private/var/run/mDNSResponder';

const GRANTED_NETWORK_RULES = [
  '(allow network-outbound (remote ip))',
  `(allow network-outbound (remote unix-socket (path-literal "${SYSTEM_RESOLVER_SOCKET}")))`,
  '(allow network-bind (local ip))',
  '(allow network-inbound (local ip))',
];

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

export async function buildSeatbeltProfile(policy: SandboxPolicy, options: { tmpDir?: string; scratchDir?: string }, paths: PathResolver): Promise<SeatbeltProfile> {
  await validateSandboxPolicy(policy, options.tmpDir === undefined ? {} : { tmpDir: options.tmpDir }, paths);
  const within = withinOf(paths);
  const roots = unique(await mapAsync(policy.writableRoots, paths.canonicalPath));
  const writeDenied = unique(await mapAsync(policy.writeDenied, paths.canonicalPath));
  const readDenied = unique(await mapAsync(policy.readDenied, paths.canonicalPath));
  const readAllowed = unique(await mapAsync(policy.readAllowed ?? [], paths.canonicalPath));
  const sessionTmpDir = options.tmpDir === undefined ? undefined : await paths.canonicalPath(options.tmpDir);
  const scratchDir = options.scratchDir === undefined ? undefined : await paths.canonicalPath(options.scratchDir);
  const area = writableAreaOf({ writableRoots: roots, entries: policy.fileRules.entries });
  const literals = unique([...policy.writeDeniedLiterals, ...policy.protectedSet.literals]);
  const literalForms = unique(await flatMapAsync(literals, async (literal) => [literal, await canonicalParentForm(literal, paths)]));
  const literalAncestors = unique(await flatMapAsync(literalForms, (target) => ancestorsWithin(target, area, 'canonical', paths)));
  const userDenies = [...policy.fileRules.entries, ...policy.protectedSet.patterns.entries].filter(isUserDeny);
  const userAncestors = unique(
    await flatMapAsync(userDenies, (entry) =>
      flatMapAsync(denyFormsOf(entry), ({ matcher, directory }) => ancestorsWithin(directory, area, 'lexical', paths, matcher.own.kind !== 'subpath')),
    ),
  );
  const userReadGuards = unique(userDenies.filter((entry) => entry.access === 'read').flatMap((entry) => denyFormsOf(entry).map(({ directory }) => directory)));
  const guardedAncestors = unique([...(await flatMapAsync(writeDenied, (target) => ancestorsWithin(target, area, 'canonical', paths))), ...literalAncestors, ...userAncestors]);
  const symlinkGuarded = unique([...literalAncestors, ...userAncestors]);
  const metadataAllowed = [...readAllowed, ...(userDenies.length > 0 && scratchDir !== undefined ? [scratchDir] : [])];
  const reallowedScratch = [...(sessionTmpDir === undefined ? [] : [sessionTmpDir]), ...(scratchDir === undefined ? [] : [scratchDir])];
  const metadataOf = async (allowed: readonly string[]): Promise<string[]> =>
    unique([...(await metadataAncestors(allowed, readDenied, within)), ...(await metadataAncestors(allowed, userReadGuards, lexicallyWithin))]);
  const reallowedMetadata = await metadataOf(reallowedScratch);
  const metadataDirs = unique([...(await metadataOf(metadataAllowed)), ...reallowedMetadata]);

  const sessionTmpEntry = sessionTmpDir === undefined ? undefined : await findAsync(readAllowed, (entry) => sameLocation(within, sessionTmpDir, entry));

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
    const sessionTmpIndex = sessionTmpEntry === undefined ? -1 : readAllowed.indexOf(sessionTmpEntry);
    if (sessionTmpIndex >= 0) lines.push(`(allow file-read* (subpath (param "${readAllowedNames[sessionTmpIndex]}")))`);
    if (scratchDir !== undefined) {
      for (const name of define('PRIVATE_TMP', [scratchDir])) {
        lines.push(`(allow file-write* (subpath (param "${name}")))`, `(allow file-read* (subpath (param "${name}")))`);
      }
    }
    for (const directory of reallowedMetadata) lines.push(`(allow file-read-metadata (literal (param "${metadataNames[metadataDirs.indexOf(directory)]}")))`);
    lines.push(...DEVICE_NODE_RULES);
  }
  const unixSocketAllow = unique(await mapAsync(policy.unixSocketAllow ?? [], paths.canonicalPath));
  if (policy.network === 'allow') lines.push(...GRANTED_NETWORK_RULES);
  if (typeof policy.network === 'object') {
    const loopbackPort = assertLoopbackPort(policy.network.loopbackPort);
    lines.push(`(allow network-outbound (remote ip "localhost:${loopbackPort}"))`);
  }
  for (const name of define('UNIX_SOCKET_ALLOW', unixSocketAllow)) {
    lines.push(`(allow network-outbound (remote unix-socket (subpath (param "${name}"))))`);
  }
  if (policy.network !== 'deny' || unixSocketAllow.length > 0) {
    for (const name of readDeniedNames) {
      lines.push(`(deny network-outbound (remote unix-socket (subpath (param "${name}"))))`);
    }
  }

  return { profile: `${lines.join('\n')}\n`, params };
}

const PROTECTION_BASE_RULES = ['(version 1)', '(allow default)'];

export function buildProtectionProfile(denied: readonly string[], scratch: readonly string[]): SeatbeltProfile {
  const params: Record<string, string> = {};
  const lines = [...PROTECTION_BASE_RULES];
  denied.forEach((area, index) => {
    const name = `HOME_DENIED_${index}`;
    params[name] = area;
    lines.push(`(deny file-read* file-write* (subpath (param "${name}")))`, `(deny network-outbound (remote unix-socket (subpath (param "${name}"))))`);
  });
  scratch.forEach((folder, index) => {
    const name = `SCRATCH_ALLOWED_${index}`;
    params[name] = folder;
    lines.push(`(allow file-read* file-write* (subpath (param "${name}")))`);
  });
  return { profile: `${lines.join('\n')}\n`, params };
}
