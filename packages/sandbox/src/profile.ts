import path from 'node:path';
import { comparableContains } from '@momonga/foundation';
import { canonicalParentForm } from './always-write-denied.ts';
import { canonicalizePath } from './canonical-path.ts';
import type { SandboxPolicy } from './types.ts';

export interface SeatbeltProfile {
  profile: string;
  params: Record<string, string>;
}

export function defaultProtectedPaths(root: string): string[] {
  return [
    path.join(root, '.git', 'hooks'),
    path.join(root, '.git', 'config'),
    path.join(root, '.momonga'),
    path.join(root, '.mcp.json'),
    path.join(root, '.envrc'),
    path.join(root, '.vscode'),
    path.join(root, '.idea'),
  ];
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

function ancestorsWithin(target: string, roots: readonly string[]): string[] {
  const found: string[] = [];
  for (let current = path.dirname(target); current !== path.dirname(current); current = path.dirname(current)) {
    if (roots.some((root) => isWithin(current, root))) found.push(current);
  }
  return found;
}

export function assertReadAllowedValid(readDenied: readonly string[], readAllowed: readonly string[]): string[] {
  const denied = unique(readDenied.map(canonicalizePath));
  return unique(readAllowed.map(canonicalizePath)).map((entry) => {
    if (!denied.some((guard) => isStrictlyWithin(entry, guard))) {
      throw new Error(`readAllowed entry must lie strictly inside a readDenied entry: ${entry}`);
    }
    if (denied.some((guard) => isWithin(guard, entry))) {
      throw new Error(`readAllowed entry must not equal or contain a readDenied entry: ${entry}`);
    }
    return entry;
  });
}

export function assertSessionTmpDirValid(policy: SandboxPolicy, tmpDir: string): string {
  const canonical = canonicalizePath(tmpDir);
  const readAllowed = (policy.readAllowed ?? []).map(canonicalizePath);
  if (!readAllowed.some((entry) => isWithin(canonical, entry) && isWithin(entry, canonical))) {
    throw new Error(`session tmpDir must be one of the readAllowed entries: ${canonical}`);
  }
  if (policy.writeDenied.map(canonicalizePath).some((entry) => isWithin(entry, canonical))) {
    throw new Error(`session tmpDir must not equal or contain a writeDenied entry: ${canonical}`);
  }
  return canonical;
}

function metadataAncestors(allowed: readonly string[], denied: readonly string[]): string[] {
  const found: string[] = [];
  for (const entry of allowed) {
    for (const guard of denied.filter((candidate) => isStrictlyWithin(entry, candidate))) {
      for (let current = path.dirname(entry); isWithin(current, guard); current = path.dirname(current)) {
        found.push(current);
        if (isWithin(guard, current)) break;
      }
    }
  }
  return unique(found);
}

const BASE_RULES = [
  '(version 1)',
  '(deny default)',
  '(allow process-exec)',
  '(allow process-fork)',
  '(allow sysctl-read)',
  '(allow signal (target same-sandbox))',
  '(allow file-read*)',
  '(allow file-write-data (literal "/dev/null") (literal "/dev/dtracehelper"))',
  '(allow file-write-data file-ioctl (literal "/dev/tty"))',
  '(allow file-write-data file-ioctl (regex #"^/dev/fd/[0-9]+$"))',
];

export function buildSeatbeltProfile(policy: SandboxPolicy, options: { tmpDir?: string } = {}): SeatbeltProfile {
  const roots = unique(policy.writableRoots.map(canonicalizePath));
  const writeDenied = unique(policy.writeDenied.map(canonicalizePath));
  const readDenied = unique(policy.readDenied.map(canonicalizePath));
  const readAllowed = assertReadAllowedValid(policy.readDenied, policy.readAllowed ?? []);
  const sessionTmpDir = options.tmpDir === undefined ? undefined : assertSessionTmpDirValid(policy, options.tmpDir);
  const literals = unique(policy.writeDeniedLiterals);
  const literalForms = unique(literals.flatMap((literal) => [literal, canonicalParentForm(literal)]));
  const literalAncestors = unique(literalForms.flatMap((target) => ancestorsWithin(target, roots)));
  const guardedAncestors = unique([...writeDenied.flatMap((target) => ancestorsWithin(target, roots)), ...literalAncestors]);

  const params: Record<string, string> = {};
  const lines = [...BASE_RULES];
  const define = (prefix: string, values: readonly string[]): string[] =>
    values.map((value, index) => {
      const name = `${prefix}_${index}`;
      params[name] = value;
      return name;
    });

  for (const name of define('WRITABLE_ROOT', roots)) lines.push(`(allow file-write* (subpath (param "${name}")))`);
  for (const name of define('WRITE_DENIED', writeDenied)) lines.push(`(deny file-write* (subpath (param "${name}")))`);
  if (sessionTmpDir !== undefined) {
    for (const name of define('SESSION_TMP', [sessionTmpDir])) lines.push(`(allow file-write* (subpath (param "${name}")))`);
  }
  for (const name of define('WRITE_DENIED_LITERAL', literals)) lines.push(`(deny file-write* (literal (param "${name}")))`);
  for (const name of define('GUARDED_ANCESTOR', guardedAncestors)) {
    lines.push(`(deny file-write-unlink (literal (param "${name}")))`);
  }
  for (const name of define('SYMLINK_GUARD', literalAncestors)) {
    lines.push(`(deny file-write-create (require-all (literal (param "${name}")) (vnode-type SYMLINK)))`);
  }
  const readDeniedNames = define('READ_DENIED', readDenied);
  for (const name of readDeniedNames) lines.push(`(deny file-read* (subpath (param "${name}")))`);
  for (const name of define('READ_ALLOWED', readAllowed)) lines.push(`(allow file-read* (subpath (param "${name}")))`);
  for (const name of define('READ_METADATA', metadataAncestors(readAllowed, readDenied))) {
    lines.push(`(allow file-read-metadata (literal (param "${name}")))`);
  }
  if (policy.network === 'allow') {
    lines.push('(allow network*)');
    for (const name of readDeniedNames) {
      lines.push(`(deny network-outbound (remote unix-socket (subpath (param "${name}"))))`);
    }
  }

  return { profile: `${lines.join('\n')}\n`, params };
}
