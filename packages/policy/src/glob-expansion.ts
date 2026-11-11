import type { UnresolvableReason } from '@momonga/foundation';
import { expandBraces } from './brace-expansion.ts';
import { askedBy } from './filesystem.ts';
import type { GlobDeadline, GlobExpander, GlobExpansion, PolicyFilesystem, PolicyHostFilesystem } from './filesystem.ts';
import { GLOB_CHARACTERS, escapeForGlob, firstUnescaped, unescapeGlob } from './glob-pattern.ts';
import { absoluteFrom } from './path-match.ts';

export type { GlobDeadline };

export const MAX_GLOB_MATCHES = 1000;

export type ExpandedGlobWord =
  | { kind: 'path' | 'match'; text: string; absolute: string }
  | { kind: 'unresolvable'; reason: UnresolvableReason };

export type GlobExpansionContext = { fs: Pick<PolicyFilesystem, 'expandGlob'>; cwd: string; home: string };

export const globBudgetMs = ({ leaseMs, heartbeatMs }: { leaseMs: number; heartbeatMs: number }): number => leaseMs - heartbeatMs;

export const createGlobDeadline = (budgetMs: number, now: () => number = () => performance.now()): GlobDeadline => {
  const end = now() + budgetMs;
  return { remainingMs: () => end - now() };
};

const dynamic = (): ExpandedGlobWord[] => [{ kind: 'unresolvable', reason: { kind: 'dynamic' } }];

type PlannedWord =
  | { kind: 'unresolvable'; reason: UnresolvableReason }
  | { kind: 'path'; text: string; absolute: string }
  | { kind: 'glob'; rooted: string; unmatched: string };

const planGlobWord = ({ cwd, home }: { cwd: string; home: string }, pattern: string): PlannedWord[] => {
  const braced = expandBraces(pattern, MAX_GLOB_MATCHES);
  if (braced === 'overflow') return [{ kind: 'unresolvable', reason: { kind: 'dynamic' } }];
  return braced.map((word): PlannedWord => {
    const rooted = word === '~' || word.startsWith('~/') ? `${escapeForGlob(home)}${word.slice(1)}` : word;
    if (rooted.startsWith('~')) return { kind: 'unresolvable', reason: { kind: 'other-user-home' } };
    const unmatched = unescapeGlob(rooted);
    if (firstUnescaped(rooted, GLOB_CHARACTERS) === -1) return { kind: 'path', text: unmatched, absolute: absoluteFrom(unmatched, cwd) };
    return { kind: 'glob', rooted, unmatched };
  });
};

export const globWordsOf = (context: { cwd: string; home: string }, pattern: string): string[] =>
  planGlobWord(context, pattern).flatMap((word) => (word.kind === 'glob' ? [word.rooted] : []));

export const expandGlobWord = ({ fs, cwd, home }: GlobExpansionContext, pattern: string): ExpandedGlobWord[] => {
  return planGlobWord({ cwd, home }, pattern).flatMap((word): ExpandedGlobWord[] => {
    if (word.kind !== 'glob') return [word];
    const expansion = fs.expandGlob(word.rooted, cwd, MAX_GLOB_MATCHES);
    if ('overflow' in expansion) return dynamic();
    if ('unresolvable' in expansion) return [{ kind: 'unresolvable', reason: expansion.unresolvable }];
    if (expansion.matches.length === 0) return [{ kind: 'path', text: word.unmatched, absolute: absoluteFrom(word.unmatched, cwd) }];
    return expansion.matches.map((match): ExpandedGlobWord => ({ kind: 'match', text: match, absolute: absoluteFrom(match, cwd) }));
  });
};

export type GlobTable = ReadonlyMap<string, GlobExpansion>;

const globKey = (cwd: string, pattern: string): string => `${cwd}\0${pattern}`;

export const EMPTY_GLOB_TABLE: GlobTable = new Map();

export const settleGlobs = (host: PolicyHostFilesystem, table: GlobTable, signal: AbortSignal): PolicyFilesystem => ({
  ...askedBy(host, signal),
  expandGlob: (pattern, cwd) => {
    const expansion = table.get(globKey(cwd, pattern));
    if (expansion === undefined) throw new Error(`the glob ${pattern} in ${cwd} was not expanded before the decision`);
    return expansion;
  },
});

export const expandGlobTable = async (expand: GlobExpander, context: { cwd: string; home: string }, patterns: readonly string[], deadline: GlobDeadline, signal: AbortSignal): Promise<GlobTable> => {
  const table = new Map<string, GlobExpansion>();
  const words = new Set(patterns.flatMap((pattern) => globWordsOf(context, pattern)));
  for (const word of words) table.set(globKey(context.cwd, word), await expand(word, context.cwd, MAX_GLOB_MATCHES, deadline, signal));
  return table;
};
