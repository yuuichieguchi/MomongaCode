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
