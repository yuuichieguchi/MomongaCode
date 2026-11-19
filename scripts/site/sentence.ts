import type { Token } from 'marked';
import { marked } from './markdown.ts';
import { decodeEntities, escapeHtml } from './text.ts';

export type Segment = { kind: 'text' | 'code'; text: string };

const segmentsOf = (file: string, tokens: readonly Token[]): Segment[] =>
  tokens.flatMap((each): Segment[] => {
    const token = marked(file, each);
    switch (token.type) {
      case 'text':
        return token.tokens === undefined ? [{ kind: 'text', text: decodeEntities(token.text) }] : segmentsOf(file, token.tokens);
      case 'escape':
        return [{ kind: 'text', text: token.text }];
      case 'br':
        return [{ kind: 'text', text: ' ' }];
      case 'codespan':
        return [{ kind: 'code', text: token.text }];
      case 'link':
        return segmentsOf(file, token.tokens);
      default:
        throw new Error(`${file}: the inline token ${token.type} is not built into a card sentence`);
    }
  });

const ABBREVIATION = /(?:^|\s)(?:\p{L}\.)+\p{L}$/u;

const endsSentence = (text: string, code: readonly boolean[], at: number): boolean => {
  const character = text[at];
  if ((character !== '.' && character !== '?') || code[at] === true) return false;
  const rest = text.slice(at + 1);
  if (rest.trim() === '') return true;
  const next = /^\s+(\S)/u.exec(rest);
  if (next === null) return false;
  const start = at + 1 + (next[0].length - 1);
  if (code[start] === true) return true;
  if (!/\p{Lu}/u.test(next[1] as string)) return false;
  return character === '?' || !ABBREVIATION.test(text.slice(0, at));
};

export const firstSentence = (file: string, tokens: readonly Token[]): Segment[] => {
  const segments = segmentsOf(file, tokens).map((segment) => (segment.kind === 'text' ? { ...segment, text: segment.text.replace(/\s+/g, ' ') } : segment));
  const text = segments.map((segment) => segment.text).join('');
  const code = segments.flatMap((segment) => Array.from({ length: segment.text.length }, () => segment.kind === 'code'));
  const stop = Array.from({ length: text.length }, (_, at) => at).find((at) => endsSentence(text, code, at)) ?? -1;
  const end = stop === -1 ? text.trimEnd().length : stop + 1;
  const cut: Segment[] = [];
  let position = 0;
  for (const segment of segments) {
    const kept = segment.text.slice(0, Math.max(0, end - position));
    position += segment.text.length;
    if (kept !== '') cut.push({ ...segment, text: kept });
  }
  const [first] = cut;
  if (first?.kind === 'text') first.text = first.text.trimStart();
  const shown = cut.filter((segment) => segment.text !== '');
  if (shown.length === 0) throw new Error(`${file}: a card sentence is empty`);
  return shown;
};

export const sentenceHtml = (sentence: readonly Segment[]): string => sentence.map((segment) => (segment.kind === 'code' ? `<code>${escapeHtml(segment.text)}</code>` : escapeHtml(segment.text))).join('');

const NO_BREAK_SPACE = '\u00a0';

type Piece = { kind: Segment['kind'] | 'break'; text: string };

const joinLastWordsOfPieces = <T extends Piece>(pieces: readonly T[]): T[] => {
  const text = pieces.map((piece) => piece.text).join('');
  const kinds = pieces.flatMap((piece) => Array.from({ length: piece.text.length }, () => piece.kind));
  const isGap = (at: number): boolean => kinds[at] === 'text' && /\s/u.test(text[at] as string);
  const isBreak = (at: number): boolean => kinds[at] === 'break';
  const gaps: number[][] = [];
  let broken = false;
  let at = text.length - 1;
  while (at >= 0 && isGap(at)) at -= 1;
  while (at >= 0 && gaps.length < 2 && !broken) {
    if (isBreak(at)) {
      broken = true;
    } else if (isGap(at)) {
      const run: number[] = [];
      while (at >= 0 && isGap(at)) {
        run.push(at);
        at -= 1;
      }
      if (at >= 0 && isBreak(at)) broken = true;
      else if (at >= 0) gaps.push(run);
    } else {
      at -= 1;
    }
  }
  const joined = new Set(gaps.length === 2 || broken ? gaps.flat() : []);
  const characters = Array.from(text, (character, index) => (joined.has(index) ? NO_BREAK_SPACE : character));
  let position = 0;
  return pieces.map((piece) => {
    const next = { ...piece, text: characters.slice(position, position + piece.text.length).join('') };
    position += piece.text.length;
    return next;
  });
};

export const joinLastWords = (segments: readonly Segment[]): Segment[] => joinLastWordsOfPieces(segments);

type Leaf = { kind: Piece['kind']; text: string; write: (text: string) => void };

const leavesOf = (file: string, tokens: readonly Token[]): Leaf[] =>
  tokens.flatMap((each): Leaf[] => {
    const token = marked(file, each);
    switch (token.type) {
      case 'text':
        if (token.tokens !== undefined) return leavesOf(file, token.tokens);
        return [{ kind: 'text', text: token.text, write: (text) => (token.text = text) }];
      case 'escape':
        return [{ kind: 'text', text: token.text, write: (text) => (token.text = text) }];
      case 'codespan':
        return [{ kind: 'code', text: token.text, write: () => undefined }];
      case 'br':
        return [{ kind: 'break', text: '\n', write: () => undefined }];
      case 'link':
      case 'strong':
      case 'em':
      case 'del':
        return leavesOf(file, token.tokens);
      default:
        throw new Error(`${file}: the inline token ${token.type} is not built into a landing text block`);
    }
  });

export const joinLastWordsOfTokens = (file: string, tokens: readonly Token[]): Token[] => {
  const copy = structuredClone(tokens) as Token[];
  const leaves = leavesOf(file, copy);
  joinLastWordsOfPieces(leaves.map((leaf): Piece => ({ kind: leaf.kind, text: leaf.text }))).forEach((segment, index) => (leaves[index] as Leaf).write(segment.text));
  return copy;
};
