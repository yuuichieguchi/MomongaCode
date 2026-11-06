import path from 'node:path';
import picomatch from 'picomatch';
import type { GoverningFactView } from '@momonga/protocol';

export type ResolveGoverningOptions = {
  now: number;
  project: string;
  touchedPaths: readonly string[];
  ignorePaths?: boolean;
};

export type GoverningConflict = { target: string; ids: string[] };

export type GoverningResolution = { active: GoverningFactView[]; conflicts: GoverningConflict[] };

export const scopeKeyOf = (scope: GoverningFactView['scope']): string =>
  scope.level === 'user' ? 'user' : `project\0${scope.project}\0${[...new Set(scope.paths)].sort().join('\0')}`;

export const isLiveFact = (fact: GoverningFactView, now: number): boolean =>
  fact.validFrom <= now && fact.retiredAt === null && (fact.validUntil === null || fact.validUntil > now);

export type PathScopeMatcher = (touched: string) => boolean;

export const pathScopeMatcherOf = (project: string, globs: readonly string[]): PathScopeMatcher => {
  const matches = picomatch([...globs], { dot: true });
  return (touched) => {
    const relative = path.relative(project, touched);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) && matches(relative.split(path.sep).join('/'));
  };
};

const touchesAny = (project: string, globs: readonly string[], touchedPaths: readonly string[]): boolean => touchedPaths.some(pathScopeMatcherOf(project, globs));

const inScope = (fact: GoverningFactView, options: ResolveGoverningOptions): boolean => {
  const { scope } = fact;
  if (scope.level === 'user') return true;
  if (scope.project !== options.project) return false;
  if (scope.paths.length === 0 || options.ignorePaths === true) return true;
  return touchesAny(options.project, scope.paths, options.touchedPaths);
};

const byStart = (left: GoverningFactView, right: GoverningFactView): number => left.validFrom - right.validFrom || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

export const resolveGoverning = (facts: readonly GoverningFactView[], options: ResolveGoverningOptions): GoverningResolution => {
  const groups = new Map<string, GoverningFactView[]>();
  for (const fact of facts) {
    if (!inScope(fact, options)) continue;
    const key = `${fact.target}\0${scopeKeyOf(fact.scope)}`;
    groups.set(key, [...(groups.get(key) ?? []), fact]);
  }
  const active: GoverningFactView[] = [];
  const conflicts: GoverningConflict[] = [];
  for (const members of groups.values()) {
    const replaced = new Set(members.filter((member) => member.validFrom <= options.now).flatMap((member) => member.supersedes));
    const kept = members.filter((member) => isLiveFact(member, options.now) && !replaced.has(member.id)).sort(byStart);
    active.push(...kept);
    const [first] = kept;
    if (kept.length >= 2 && first !== undefined) conflicts.push({ target: first.target, ids: kept.map((member) => member.id).sort() });
  }
  return {
    active: active.sort(byStart),
    conflicts: conflicts.sort((left, right) => (left.target < right.target ? -1 : left.target > right.target ? 1 : left.ids.join() < right.ids.join() ? -1 : 1)),
  };
};
