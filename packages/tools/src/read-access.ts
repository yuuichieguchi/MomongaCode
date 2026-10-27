import path from 'node:path';
import { absoluteFrom } from '@momonga/policy';
import { canonicalPath, comparableContains, fileRuleBlocks, resolveCanonicalPath } from '@momonga/foundation';
import type { FileRuleEntry, FileRuleProvenance, FileRuleSet } from '@momonga/foundation';

export type ReadAccessPolicy = {
  readDenied: readonly string[];
  readAllowed?: readonly string[] | undefined;
  fileRules: FileRuleSet;
};

export type ReadFamilyTool = 'Read' | 'Grep' | 'Glob';

const isStrictlyInside = (candidate: string, directory: string): boolean =>
  comparableContains(directory, candidate) && !comparableContains(candidate, directory);

const firstBlocking = (
  fileRules: FileRuleSet,
  entries: readonly FileRuleEntry[],
  requested: string,
  resolved: string,
): FileRuleProvenance | undefined => entries.find((entry) => fileRuleBlocks(fileRules, entry, requested, resolved))?.provenance;

export const createReadAccessMatcher = (policy: ReadAccessPolicy) => {
  const denied: string[] = policy.readDenied.map(canonicalPath);
  const allowed: string[] = (policy.readAllowed ?? []).map(canonicalPath);
  const { fileRules } = policy;
  const denyEntries = fileRules.entries.filter((entry) => entry.effect === 'deny' && entry.unresolved === null);
  const readEntriesFor = (tool: ReadFamilyTool): FileRuleEntry[] =>
    denyEntries.filter((entry) => entry.access === 'read' && (entry.tool === 'Read' || entry.tool === tool));
  const writeEntries = denyEntries.filter((entry) => entry.access === 'write');

  const blocksResolved = (resolved: string): boolean =>
    denied.some(
      (guard) =>
        comparableContains(guard, resolved) &&
        !allowed.some((exception) => isStrictlyInside(exception, guard) && comparableContains(exception, resolved)),
    );

  const formsOf = (target: string, cwd: string): { requested: string; resolved: string } => {
    const requested = path.resolve(cwd, target);
    const resolution = resolveCanonicalPath(absoluteFrom(target, cwd));
    return { requested, resolved: resolution.ok ? resolution.path : requested };
  };

  return {
    deniesAnything: denied.length > 0,
    blocksResolved,
    blocks: (target: string, cwd: string): boolean =>
      blocksResolved(canonicalPath(absoluteFrom(target, cwd))) || blocksResolved(path.resolve(cwd, target)),
    blockedBy: (target: string, cwd: string, tool: ReadFamilyTool = 'Read'): FileRuleProvenance | undefined => {
      const entries = readEntriesFor(tool);
      if (entries.length === 0) return undefined;
      const { requested, resolved } = formsOf(target, cwd);
      return firstBlocking(fileRules, entries, requested, resolved);
    },
    blockedByForms: (requested: string, resolved: string, tool: ReadFamilyTool = 'Read'): FileRuleProvenance | undefined =>
      firstBlocking(fileRules, readEntriesFor(tool), requested, resolved),
    writeBlockedBy: (target: string, cwd: string): FileRuleProvenance | undefined => {
      if (writeEntries.length === 0) return undefined;
      const { requested, resolved } = formsOf(target, cwd);
      return firstBlocking(fileRules, writeEntries, requested, resolved);
    },
    isAllowedEntry: (resolved: string): boolean => allowed.some((guard) => comparableContains(guard, resolved)),
    leadsToAllowed: (resolved: string): boolean => allowed.some((guard) => isStrictlyInside(guard, resolved)),
    deniedWithin: (directory: string): string[] => denied.filter((guard) => isStrictlyInside(guard, directory)),
    allowedWithin: (directory: string): string[] => allowed.filter((guard) => isStrictlyInside(guard, directory)),
  };
};

export type ReadAccessMatcher = ReturnType<typeof createReadAccessMatcher>;
