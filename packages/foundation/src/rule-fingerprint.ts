import type { PathResolver } from './path-compare.ts';
import { canonicalJson, sha256Hex } from './canonical-json.ts';

export const RULE_VERDICT_DEFINITION = 2;

export const ruleFingerprint = (subject: { input: unknown; solverVersion: string }): string =>
  sha256Hex(canonicalJson({ input: subject.input, solverVersion: subject.solverVersion, verdictDefinition: RULE_VERDICT_DEFINITION }));

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
