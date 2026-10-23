import path from 'node:path';
import { absoluteFrom } from '@momonga/policy';
import { assertReadAllowedValid } from '@momonga/sandbox';
import { canonicalPath, comparableContains } from '@momonga/foundation';

export const canonicalOrResolved = (entry: string): string => canonicalPath(path.isAbsolute(entry) ? entry : path.resolve(entry));

export type ReadAccessPolicy = {
  readDenied: readonly string[];
  readAllowed?: readonly string[] | undefined;
};

const isStrictlyInside = (candidate: string, directory: string): boolean =>
  comparableContains(directory, candidate) && !comparableContains(candidate, directory);

export const createReadAccessMatcher = (policy: ReadAccessPolicy) => {
  assertReadAllowedValid(policy.readDenied, policy.readAllowed ?? []);
  const denied: string[] = policy.readDenied.map(canonicalOrResolved);
  const allowed: string[] = (policy.readAllowed ?? []).map(canonicalOrResolved);

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
      blocksResolved(canonicalOrResolved(absoluteFrom(target, cwd))) || blocksResolved(path.resolve(cwd, target)),
    isAllowedEntry: (resolved: string): boolean => allowed.some((guard) => comparableContains(guard, resolved)),
    leadsToAllowed: (resolved: string): boolean => allowed.some((guard) => isStrictlyInside(guard, resolved)),
    deniedWithin: (directory: string): string[] => denied.filter((guard) => isStrictlyInside(guard, directory)),
    allowedWithin: (directory: string): string[] => allowed.filter((guard) => isStrictlyInside(guard, directory)),
  };
};

export type ReadAccessMatcher = ReturnType<typeof createReadAccessMatcher>;
