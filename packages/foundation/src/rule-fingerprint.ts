import type { PathResolver } from './path-compare.ts';
import { canonicalJson, sha256Hex } from './canonical-json.ts';

export const RULE_VERDICT_DEFINITION = 5;

export type VerdictSubject = {
  readonly rules: readonly unknown[];
  readonly roots: readonly string[];
  readonly mode: string;
  readonly home: string;
  readonly cwd: string;
  readonly exemptDirectory: string | null;
  readonly enforcement: unknown;
  readonly protectedSet: unknown;
  readonly secretLocations: readonly unknown[];
  readonly deniedLocations: readonly unknown[];
};

export const verdictSubjectOf = <Subject extends VerdictSubject>({
  rules,
  roots,
  mode,
  home,
  cwd,
  exemptDirectory,
  enforcement,
  protectedSet,
  secretLocations,
  deniedLocations,
}: Subject): Pick<Subject, keyof VerdictSubject> => ({ rules, roots: [...new Set(roots)], mode, home, cwd, exemptDirectory, enforcement, protectedSet, secretLocations, deniedLocations });

export const verdictKey = (subject: VerdictSubject, solver: string): string => sha256Hex(canonicalJson({ subject, solver, verdictDefinition: RULE_VERDICT_DEFINITION }));

export type SessionRoots = { ok: true; roots: string[] } | { ok: false; root: string; reason: string };

export const sessionRootsOf = async (cwd: string, additional: readonly string[], paths: Pick<PathResolver, 'canonicalDirectory' | 'comparablePath'>): Promise<SessionRoots> => {
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const root of [cwd, ...additional]) {
    const resolved = await paths.canonicalDirectory(root);
    if (!resolved.ok) return { ok: false, root, reason: resolved.reason };
    const key = await paths.comparablePath(resolved.path);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(resolved.path);
  }
  return { ok: true, roots };
};
