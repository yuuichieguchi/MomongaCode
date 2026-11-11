import path from 'node:path';
import { absoluteFrom } from '@momonga/policy';
import { fileRuleBlockingForm, filterAsync, mapAsync, someAsync } from '@momonga/foundation';
import type { FileRuleEntry, FileRuleProvenance, FileRuleSet, PathResolver } from '@momonga/foundation';

export type ReadAccessPolicy = {
  readDenied: readonly string[];
  readAllowed?: readonly string[] | undefined;
  fileRules: FileRuleSet;
};

export type FileRuleBlock = { provenance: FileRuleProvenance; matched: string };

export type ReadFamilyTool = 'Read' | 'Grep' | 'Glob';

const firstBlocking = (
  fileRules: FileRuleSet,
  entries: readonly FileRuleEntry[],
  requested: string,
  resolved: string,
): FileRuleBlock | undefined => {
  for (const entry of entries) {
    const form = fileRuleBlockingForm(fileRules, entry, requested, resolved);
    if (form !== undefined) return { provenance: entry.provenance, matched: form === 'requested' ? requested : resolved };
  }
  return undefined;
};

export const createReadAccessMatcher = async (policy: ReadAccessPolicy, paths: PathResolver) => {
  const denied: string[] = await mapAsync(policy.readDenied, paths.canonicalPath);
  const allowed: string[] = await mapAsync(policy.readAllowed ?? [], paths.canonicalPath);
  const { fileRules } = policy;
  const denyEntries = fileRules.entries.filter((entry) => entry.effect === 'deny' && entry.unresolved === null);
  const readEntriesFor = (tool: ReadFamilyTool): FileRuleEntry[] =>
    denyEntries.filter((entry) => entry.access === 'read' && (entry.tool === 'Read' || entry.tool === tool));
  const writeEntries = denyEntries.filter((entry) => entry.access === 'write');

  const isStrictlyInside = async (candidate: string, directory: string): Promise<boolean> =>
    (await paths.comparableContains(directory, candidate)) && !(await paths.comparableContains(candidate, directory));

  const blocksResolved = (resolved: string): Promise<boolean> =>
    someAsync(
      denied,
      async (guard) =>
        (await paths.comparableContains(guard, resolved)) &&
        !(await someAsync(allowed, async (exception) => (await isStrictlyInside(exception, guard)) && (await paths.comparableContains(exception, resolved)))),
    );

  const formsOf = async (target: string, cwd: string): Promise<{ requested: string; resolved: string }> => {
    const requested = path.resolve(cwd, target);
    const resolution = await paths.resolveCanonicalPath(absoluteFrom(target, cwd));
    return { requested, resolved: resolution.ok ? resolution.path : requested };
  };

  return {
    deniesAnything: denied.length > 0,
    hasReadRulesFor: (tool: ReadFamilyTool): boolean => readEntriesFor(tool).length > 0,
    blocksResolved,
    blocks: async (target: string, cwd: string): Promise<boolean> =>
      (await blocksResolved(await paths.canonicalPath(absoluteFrom(target, cwd)))) || (await blocksResolved(path.resolve(cwd, target))),
    blockedMatch: async (target: string, cwd: string, tool: ReadFamilyTool = 'Read'): Promise<FileRuleBlock | undefined> => {
      const entries = readEntriesFor(tool);
      if (entries.length === 0) return undefined;
      const { requested, resolved } = await formsOf(target, cwd);
      return firstBlocking(fileRules, entries, requested, resolved);
    },
    blockedBy: async (target: string, cwd: string, tool: ReadFamilyTool = 'Read'): Promise<FileRuleProvenance | undefined> => {
      const entries = readEntriesFor(tool);
      if (entries.length === 0) return undefined;
      const { requested, resolved } = await formsOf(target, cwd);
      return firstBlocking(fileRules, entries, requested, resolved)?.provenance;
    },
    blockedByForms: (requested: string, resolved: string, tool: ReadFamilyTool = 'Read'): FileRuleProvenance | undefined =>
      firstBlocking(fileRules, readEntriesFor(tool), requested, resolved)?.provenance,
    writeBlockedMatch: async (target: string, cwd: string): Promise<FileRuleBlock | undefined> => {
      if (writeEntries.length === 0) return undefined;
      const { requested, resolved } = await formsOf(target, cwd);
      return firstBlocking(fileRules, writeEntries, requested, resolved);
    },
    writeBlockedBy: async (target: string, cwd: string): Promise<FileRuleProvenance | undefined> => {
      if (writeEntries.length === 0) return undefined;
      const { requested, resolved } = await formsOf(target, cwd);
      return firstBlocking(fileRules, writeEntries, requested, resolved)?.provenance;
    },
    blockedForm: async (target: string, cwd: string): Promise<string | undefined> => {
      const { requested, resolved } = await formsOf(target, cwd);
      if (await blocksResolved(requested)) return requested;
      return (await blocksResolved(resolved)) ? resolved : undefined;
    },
    isAllowedEntry: (resolved: string): Promise<boolean> => someAsync(allowed, (guard) => paths.comparableContains(guard, resolved)),
    leadsToAllowed: (resolved: string): Promise<boolean> => someAsync(allowed, (guard) => isStrictlyInside(guard, resolved)),
    deniedWithin: (directory: string): Promise<string[]> => filterAsync(denied, (guard) => isStrictlyInside(guard, directory)),
    allowedWithin: (directory: string): Promise<string[]> => filterAsync(allowed, (guard) => isStrictlyInside(guard, directory)),
  };
};

export type ReadAccessMatcher = Awaited<ReturnType<typeof createReadAccessMatcher>>;
