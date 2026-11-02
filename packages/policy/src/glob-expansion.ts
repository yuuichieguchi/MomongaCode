import type { UnresolvableReason } from '@momonga/foundation';
import { expandBraces } from './brace-expansion.ts';
import type { PolicyFilesystem } from './filesystem.ts';
import { GLOB_CHARACTERS, escapeForGlob, firstUnescaped, unescapeGlob } from './glob-pattern.ts';
import { absoluteFrom } from './path-match.ts';

export const MAX_GLOB_MATCHES = 1000;

export type ExpandedGlobWord =
  | { kind: 'path' | 'match'; text: string; absolute: string }
  | { kind: 'unresolvable'; reason: UnresolvableReason };

export type GlobExpansionContext = { fs: Pick<PolicyFilesystem, 'expandGlob'>; cwd: string; home: string };

const dynamic = (): ExpandedGlobWord[] => [{ kind: 'unresolvable', reason: { kind: 'dynamic' } }];

export const expandGlobWord = ({ fs, cwd, home }: GlobExpansionContext, pattern: string): ExpandedGlobWord[] => {
  const braced = expandBraces(pattern, MAX_GLOB_MATCHES);
  if (braced === 'overflow') return dynamic();
  return braced.flatMap((word): ExpandedGlobWord[] => {
    const rooted = word === '~' || word.startsWith('~/') ? `${escapeForGlob(home)}${word.slice(1)}` : word;
    if (rooted.startsWith('~')) return [{ kind: 'unresolvable', reason: { kind: 'other-user-home' } }];
    const unmatched = unescapeGlob(rooted);
    if (firstUnescaped(rooted, GLOB_CHARACTERS) === -1) return [{ kind: 'path', text: unmatched, absolute: absoluteFrom(unmatched, cwd) }];
    const expansion = fs.expandGlob(rooted, cwd, MAX_GLOB_MATCHES);
    if ('overflow' in expansion) return dynamic();
    if ('unresolvable' in expansion) return [{ kind: 'unresolvable', reason: expansion.unresolvable }];
    if (expansion.matches.length === 0) return [{ kind: 'path', text: unmatched, absolute: absoluteFrom(unmatched, cwd) }];
    return expansion.matches.map((match): ExpandedGlobWord => ({ kind: 'match', text: match, absolute: absoluteFrom(match, cwd) }));
  });
};
