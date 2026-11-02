import path from 'node:path';
import { canonicalPath, comparableContains } from '@momonga/foundation';
import type { RuleEnforcement } from '@momonga/foundation';
import { absoluteFrom, computeFileRules } from '@momonga/policy';
import type { PermissionRule } from '@momonga/policy';
import { createReadAccessMatcher } from '../read-access.ts';
import type { ReadDenial } from './port.ts';

export type ReadDenialOptions = { rules: readonly PermissionRule[]; roots: readonly string[]; cwd: string; enforcement: RuleEnforcement };

export const createReadDenial = ({ rules, roots, cwd, enforcement }: ReadDenialOptions): ReadDenial => {
  const fileRules = computeFileRules(rules, roots, null, enforcement);
  const matcher = createReadAccessMatcher({ readDenied: [], fileRules });
  const anchors = fileRules.entries
    .filter((entry) => entry.effect === 'deny' && entry.access === 'read' && entry.tool === 'Read' && entry.unresolved === null)
    .map((entry) => entry.anchorDirectory);
  return (target) => {
    if (matcher.blockedBy(target, cwd, 'Read') !== undefined) return true;
    const forms = [path.resolve(cwd, target), canonicalPath(absoluteFrom(target, cwd))];
    return anchors.some((anchor) => forms.some((form) => comparableContains(form, anchor)));
  };
};
