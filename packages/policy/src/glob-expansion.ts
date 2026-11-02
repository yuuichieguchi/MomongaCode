import path from 'node:path';
import type { UnresolvableReason } from '@momonga/foundation';
import { expandBraces } from './brace-expansion.ts';
import type { PolicyFilesystem } from './filesystem.ts';
import { absoluteFrom } from './path-match.ts';

export const MAX_GLOB_MATCHES = 1000;

const GLOB_METACHARACTER = /[*?[]/;

export type ExpandedGlobWord =
  | { kind: 'path' | 'match'; text: string; absolute: string }
  | { kind: 'unresolvable'; reason: UnresolvableReason };

export type GlobExpansionContext = { fs: Pick<PolicyFilesystem, 'expandGlob'>; cwd: string; home: string };

const dynamic = (): ExpandedGlobWord[] => [{ kind: 'unresolvable', reason: { kind: 'dynamic' } }];

export const expandGlobWord = ({ fs, cwd, home }: GlobExpansionContext, pattern: string): ExpandedGlobWord[] => {
  const braced = expandBraces(pattern, MAX_GLOB_MATCHES);
  if (braced === 'overflow') return dynamic();
  return braced.flatMap((word): ExpandedGlobWord[] => {
    const rooted = word === '~' || word.startsWith('~/') ? path.join(home, word.slice(1)) : word;
    if (rooted.startsWith('~')) return [{ kind: 'unresolvable', reason: { kind: 'other-user-home' } }];
    if (!GLOB_METACHARACTER.test(rooted)) return [{ kind: 'path', text: rooted, absolute: absoluteFrom(rooted, cwd) }];
    const expansion = fs.expandGlob(rooted, cwd, MAX_GLOB_MATCHES);
    if ('overflow' in expansion) return dynamic();
    if ('unresolvable' in expansion) return [{ kind: 'unresolvable', reason: expansion.unresolvable }];
    if (expansion.matches.length === 0) return [{ kind: 'path', text: rooted, absolute: absoluteFrom(rooted, cwd) }];
    return expansion.matches.map((match): ExpandedGlobWord => ({ kind: 'match', text: match, absolute: absoluteFrom(match, cwd) }));
  });
};
