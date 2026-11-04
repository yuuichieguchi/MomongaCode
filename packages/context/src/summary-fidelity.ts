import type { SummaryFidelity, SummarySectionCoverage } from '@momonga/protocol';

export type FidelitySource = {
  region: string;
  pinned: string;
  previousSummary: string;
  critical: readonly string[];
  workingState: string;
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
const MIN_SUFFIX_SEGMENTS = 2;

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

const forwardSlashes = (text: string): string => text.replaceAll('\\', '/');

const normalisedSegments = (token: string): string[] =>
  forwardSlashes(token)
    .replace(/^(?:\.\/)+/, '')
    .split('/')
    .filter((segment) => segment !== '');

export const occursIn = (token: string, haystack: string): boolean => {
  const haystacks = [haystack, forwardSlashes(haystack)];
  if (haystacks.some((text) => text.includes(token) || text.includes(forwardSlashes(token)))) return true;
  if (!/[/\\]/.test(token)) return false;
  const segments = normalisedSegments(token);
  for (let start = 0; start + MIN_SUFFIX_SEGMENTS <= segments.length; start += 1) {
    const suffix = segments.slice(start).join('/');
    if (haystacks.some((text) => text.includes(suffix))) return true;
  }
  return false;
};

const coverageOf = (found: number): SummarySectionCoverage => (found === SECTIONS.length ? 'complete' : found === 0 ? 'none' : 'partial');

export const checkSummary = (summary: string, source: FidelitySource): SummaryFidelity => {
  const segments = segmentsOf(summary);
  const named = new Set(segments.flatMap((segment) => (segment.name === undefined ? [] : [segment.name])));
  const checked = segments
    .filter((segment) => segment.name !== EXEMPT_SECTION)
    .map((segment) => segment.lines.join('\n'))
    .join('\n');
  const known = [source.region, source.pinned, source.previousSummary].join('\n');
  const critical = [...new Set(source.critical)];
  return {
    fabricated: checkedTokens(checked).filter((token) => !occursIn(token, known)),
    identifiers: critical.length,
    retained: critical.filter((identifier) => summary.includes(identifier) || source.workingState.includes(identifier)).length,
    sections: coverageOf(named.size),
  };
};
