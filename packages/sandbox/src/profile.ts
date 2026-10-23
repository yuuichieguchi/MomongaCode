import path from 'node:path';
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
  return candidate === root || candidate.startsWith(root === path.sep ? root : root + path.sep);
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

export function buildSeatbeltProfile(policy: SandboxPolicy): SeatbeltProfile {
  const roots = unique(policy.writableRoots.map(canonicalizePath));
  const writeDenied = unique(policy.writeDenied.map(canonicalizePath));
  const readDenied = unique(policy.readDenied.map(canonicalizePath));
  const guardedAncestors = unique(writeDenied.flatMap((target) => ancestorsWithin(target, roots)));

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
  for (const name of define('GUARDED_ANCESTOR', guardedAncestors)) {
    lines.push(`(deny file-write-unlink (literal (param "${name}")))`);
  }
  const readDeniedNames = define('READ_DENIED', readDenied);
  for (const name of readDeniedNames) lines.push(`(deny file-read* (subpath (param "${name}")))`);
  if (policy.network === 'allow') {
    lines.push('(allow network*)');
    for (const name of readDeniedNames) {
      lines.push(`(deny network-outbound (remote unix-socket (subpath (param "${name}"))))`);
    }
  }

  return { profile: `${lines.join('\n')}\n`, params };
}
