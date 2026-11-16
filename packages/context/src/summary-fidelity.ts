import { tokenMatcherOf } from '@momonga/protocol';
import type { ClaimedToken, SummaryFidelity, SummarySectionCoverage } from '@momonga/protocol';

export type FidelitySource = {
  attested: readonly string[];
  pinned: string;
  critical: readonly string[];
  workingState: string;
};

export type FidelityRecord = {
  executedLeaves: readonly string[];
  executedText: readonly string[];
  statedText: readonly string[];
};

const SECTIONS = ['GOAL', 'STATE', 'DONE', 'TODO', 'DECISIONS', 'GUARDRAILS'] as const;
const EXEMPT_SECTION = 'TODO';
const HEADING = new RegExp(`^[ \\t]*(?:[-*+>][ \\t]+)?(?:#{1,6}[ \\t]*)?\\**(${SECTIONS.join('|')})\\**[ \\t]*(:)?\\**[ \\t]*(.*)$`, 'i');
const LINE_SUFFIX = /:\d+(?::\d+)?$/;
const BACKTICKED = /`([^`\n]+)`/g;
const PATH_SHAPED = /(?:~|\.{1,2})?\/?(?:[\w@%+=,.-]+\/)+[\w@%+=,.-]+/g;
const HEX_SHAPED = /\b[0-9a-f]{7,}\b/g;
const HAS_DIGIT = /[0-9]/;
const HAS_HEX_LETTER = /[a-f]/;
const TRAILING_PUNCTUATION = /[.,]+$/;
const FILE_EXTENSION = /\.[A-Za-z][\w-]*$/;
const STRICT_SECTIONS: readonly string[] = ['STATE', 'DONE'];

type Segment = { name: string | undefined; lines: string[] };

const segmentsOf = (text: string): Segment[] => {
  const segments: Segment[] = [{ name: undefined, lines: [] }];
  for (const line of text.split('\n')) {
    const heading = HEADING.exec(line);
    if (heading !== null && (heading[2] !== undefined || (heading[3] as string).trim() === '')) {
      segments.push({ name: (heading[1] as string).toUpperCase(), lines: [heading[3] as string] });
    } else {
      (segments.at(-1) as Segment).lines.push(line);
    }
  }
  return segments;
};

const decodedEntities = (token: string): string => token.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

const withoutLineSuffix = (token: string): string => (/[/\\]|\.[A-Za-z]/.test(token) ? token.replace(LINE_SUFFIX, '') : token);

const isPathToken = (token: string): boolean => {
  if (!/[A-Za-z]/.test(token)) return false;
  const anchored = /^(?:\/|\.{1,2}\/|~\/)/.test(token);
  const segments = token.split('/').filter((segment) => segment !== '');
  return anchored || FILE_EXTENSION.test(token) || segments.length >= 3;
};

export const checkedTokens = (text: string): string[] => {
  const tokens: string[] = [];
  const outsideBackticks = text.replace(BACKTICKED, (_match, inner: string) => {
    tokens.push(inner.trim());
    return ' ';
  });
  for (const match of outsideBackticks.matchAll(PATH_SHAPED)) {
    const token = match[0].replace(TRAILING_PUNCTUATION, '');
    if (isPathToken(token)) tokens.push(token);
  }
  for (const match of outsideBackticks.matchAll(HEX_SHAPED)) {
    if (HAS_DIGIT.test(match[0]) && HAS_HEX_LETTER.test(match[0])) tokens.push(match[0]);
  }
  return [...new Set(tokens.filter((token) => token !== '').map((token) => withoutLineSuffix(decodedEntities(token))))];
};

export const claimedTokens = (summary: string): ClaimedToken[] => {
  const checked = segmentsOf(summary).filter((segment) => segment.name !== EXEMPT_SECTION);
  const strict = new Set(
    checked.filter((segment) => segment.name !== undefined && STRICT_SECTIONS.includes(segment.name)).flatMap((segment) => checkedTokens(segment.lines.join('\n'))),
  );
  return checkedTokens(checked.map((segment) => segment.lines.join('\n')).join('\n')).map(
    (token): ClaimedToken => ({ token, claim: strict.has(token) ? 'executed' : 'any' }),
  );
};

const occursIn = (token: string, cwd: string, texts: readonly string[]): boolean => {
  const matcher = tokenMatcherOf(token, cwd);
  return texts.some((text) => matcher.matches(text, true));
};

const coverageOf = (found: number): SummarySectionCoverage => (found === SECTIONS.length ? 'complete' : found === 0 ? 'none' : 'partial');

export const checkSummary = (summary: string, source: FidelitySource): SummaryFidelity => {
  const named = new Set(segmentsOf(summary).flatMap((segment) => (segment.name === undefined ? [] : [segment.name])));
  const attested = new Set(source.attested);
  const critical = [...new Set(source.critical)];
  return {
    fabricated: claimedTokens(summary)
      .filter(({ token, claim }) => !attested.has(token) && !(claim === 'any' && occursIn(token, '', [source.pinned])))
      .map(({ token }) => token),
    identifiers: critical.length,
    retained: critical.filter((identifier) => summary.includes(identifier) || source.workingState.includes(identifier)).length,
    sections: coverageOf(named.size),
  };
};
