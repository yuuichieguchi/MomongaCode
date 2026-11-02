import { canonicalPath } from './path-compare.ts';

export const UNRESOLVABLE_ERRNO_CODES = ['EACCES', 'ELOOP', 'ENAMETOOLONG', 'ENOTDIR', 'ENOENT'] as const;

export type UnresolvableErrno = (typeof UNRESOLVABLE_ERRNO_CODES)[number];

export type UnresolvableReason =
  | { kind: 'errno'; code: UnresolvableErrno }
  | { kind: 'cwd-changed' }
  | { kind: 'root-changed' }
  | { kind: 'dynamic' }
  | { kind: 'other-user-home' }
  | { kind: 'config-override' }
  | { kind: 'unanalyzable' };

export type Unresolved = { unresolvable: UnresolvableReason };

export type PathResolution = { ok: true; path: string } | { ok: false; reason: UnresolvableReason };

const isUnresolvableErrno = (code: unknown): code is UnresolvableErrno => UNRESOLVABLE_ERRNO_CODES.some((candidate) => candidate === code);

export const unresolvableReasonOf = (error: unknown): UnresolvableReason | undefined => {
  const code = (error as NodeJS.ErrnoException).code;
  return isUnresolvableErrno(code) ? { kind: 'errno', code } : undefined;
};

export const resolveCanonicalPath = (absolute: string, canonicalise: (absolute: string) => string = canonicalPath): PathResolution => {
  try {
    return { ok: true, path: canonicalise(absolute) };
  } catch (error) {
    const reason = unresolvableReasonOf(error);
    if (reason === undefined) throw error;
    return { ok: false, reason };
  }
};
