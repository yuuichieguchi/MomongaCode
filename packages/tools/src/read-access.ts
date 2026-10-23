import path from 'node:path';
import { absoluteFrom } from '@momonga/policy';
import { assertReadAllowedValid } from '@momonga/sandbox';
import { canonicalPath, comparableContains } from '@momonga/foundation';

export const assertAbsoluteEntries = (field: string, entries: readonly string[]): void => {
  for (const entry of entries) {
    if (!path.isAbsolute(entry)) throw new Error(`${field} entry must be an absolute path: ${entry}`);
  }
};

export type ReadAccessPolicy = {
  readDenied: readonly string[];
  readAllowed?: readonly string[] | undefined;
};

const isStrictlyInside = (candidate: string, directory: string): boolean =>
  comparableContains(directory, candidate) && !comparableContains(candidate, directory);

export const createReadAccessMatcher = (policy: ReadAccessPolicy) => {
  assertAbsoluteEntries('readDenied', policy.readDenied);
  assertAbsoluteEntries('readAllowed', policy.readAllowed ?? []);
  assertReadAllowedValid(policy.readDenied, policy.readAllowed ?? []);
  const denied: string[] = policy.readDenied.map(canonicalPath);
  const allowed: string[] = (policy.readAllowed ?? []).map(canonicalPath);

  const blocksResolved = (resolved: string): boolean =>
    denied.some(
      (guard) =>
        comparableContains(guard, resolved) &&
        !allowed.some((exception) => isStrictlyInside(exception, guard) && comparableContains(exception, resolved)),
    );

  return {
    deniesAnything: denied.length > 0,
    blocksResolved,
    blocks: (target: string, cwd: string): boolean =>
      blocksResolved(canonicalPath(absoluteFrom(target, cwd))) || blocksResolved(path.resolve(cwd, target)),
    isAllowedEntry: (resolved: string): boolean => allowed.some((guard) => comparableContains(guard, resolved)),
    leadsToAllowed: (resolved: string): boolean => allowed.some((guard) => isStrictlyInside(guard, resolved)),
    deniedWithin: (directory: string): string[] => denied.filter((guard) => isStrictlyInside(guard, directory)),
    allowedWithin: (directory: string): string[] => allowed.filter((guard) => isStrictlyInside(guard, directory)),
  };
};

export type ReadAccessMatcher = ReturnType<typeof createReadAccessMatcher>;
