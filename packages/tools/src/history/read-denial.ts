import path from 'node:path';
import { hostPaths, someAsync } from '@momonga/foundation';
import type { RuleEnforcement } from '@momonga/foundation';
import { absoluteFrom, computeFileRules } from '@momonga/policy';
import type { PermissionRule } from '@momonga/policy';
import { createReadAccessMatcher } from '../read-access.ts';
import type { ReadDenial } from './port.ts';

export type ReadDenialOptions = { rules: readonly PermissionRule[]; roots: readonly string[]; cwd: string; enforcement: RuleEnforcement; signal: AbortSignal };

export const createReadDenial = async ({ rules, roots, cwd, enforcement, signal }: ReadDenialOptions): Promise<ReadDenial> => {
  const paths = hostPaths(signal);
  const fileRules = await computeFileRules(rules, roots, null, enforcement, { canonicalise: paths.resolveCanonicalPath, volumeProbe: paths.volumeIsCaseInsensitive });
  const matcher = await createReadAccessMatcher({ readDenied: [], fileRules }, paths);
  const anchors = fileRules.entries
    .filter((entry) => entry.effect === 'deny' && entry.access === 'read' && entry.tool === 'Read' && entry.unresolved === null)
    .map((entry) => entry.anchorDirectory);
  return async (target) => {
    if ((await matcher.blockedBy(target, cwd, 'Read')) !== undefined) return true;
    const forms = [path.resolve(cwd, target), await paths.canonicalPath(absoluteFrom(target, cwd))];
    return someAsync(anchors, (anchor) => someAsync(forms, (form) => paths.comparableContains(form, anchor)));
  };
};
