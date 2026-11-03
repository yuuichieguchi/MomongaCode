import { isRecord } from '@momonga/foundation';
import type { ContributionKind, RunEvent } from '@momonga/protocol';

export type InjectedItem = { kind: ContributionKind; id: string; text: string; fromSeq: number };

export type ItemContribution = { kind: ContributionKind; id: string; contributed: boolean };

export const MIN_IDENTIFIER_CHARS = 6;

const CHUNKS = /[A-Za-z0-9_]+(?:[./-][A-Za-z0-9_]+)*/g;
const SEPARATORS = /[./-]/;
const WHOLE_WORD = /^[A-Za-z0-9_]+$/;
const HAS_LETTER = /[A-Za-z]/;

type Tokens = ReadonlySet<string>;

type Segment = { itemSeq: number; tokens: Tokens };

const tokensOf = (text: string): Tokens => {
  const tokens = new Set<string>();
  for (const [chunk] of text.matchAll(CHUNKS)) {
    tokens.add(chunk);
    for (const word of chunk.split(SEPARATORS)) tokens.add(word);
  }
  return tokens;
};

const someToken = (tokens: Tokens, test: (token: string) => boolean): boolean => {
  for (const token of tokens) if (test(token)) return true;
  return false;
};

const stringsOf = (value: unknown): string[] =>
  typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(stringsOf) : isRecord(value) ? Object.values(value).flatMap(stringsOf) : [];

const isPath = (identifier: string): boolean => identifier.includes('/');

const identifiersOf = (item: InjectedItem): string[] => {
  const own = [...tokensOf(item.text)].filter(
    (token) => isPath(token) || (WHOLE_WORD.test(token) && token.length >= MIN_IDENTIFIER_CHARS && HAS_LETTER.test(token)),
  );
  return [...new Set([...own, item.id])];
};

const occursIn = (sets: readonly Tokens[], identifier: string): boolean =>
  isPath(identifier)
    ? sets.some((tokens) => someToken(tokens, (token) => token === identifier || token.endsWith(`/${identifier}`)))
    : sets.some((tokens) => tokens.has(identifier));

const stepTextOf = (output: readonly unknown[]): string =>
  output
    .flatMap((item): string[] => {
      if (!isRecord(item)) return [];
      if (item['type'] === 'function_call') return typeof item['arguments'] === 'string' ? [item['arguments']] : [];
      if (item['type'] !== 'message' || !Array.isArray(item['content'])) return [];
      return item['content'].flatMap((part: unknown) => (isRecord(part) && typeof part['text'] === 'string' ? [part['text']] : []));
    })
    .join('\n');

export const measureContribution = ({
  events,
  task,
  injected,
}: {
  events: readonly RunEvent[];
  task: string;
  injected: readonly InjectedItem[];
}): ItemContribution[] => {
  const permanent = tokensOf(task);
  const identifiers = injected.map(identifiersOf);
  const credited = new Set<number>();
  let segments: Segment[] = [];
  let nextItemSeq = 1;

  const retain = (text: string): void => {
    segments.push({ itemSeq: nextItemSeq, tokens: tokensOf(text) });
    nextItemSeq += 1;
  };

  for (const event of events) {
    switch (event.type) {
      case 'user.message':
        retain(event.text);
        break;
      case 'tool.completed':
      case 'tool.reconciled':
        retain(event.output);
        break;
      case 'context.compacted':
        segments = segments.filter((segment) => segment.itemSeq > event.replacedThroughSeq);
        break;
      case 'context.inherited':
        segments = [
          ...event.history.map((entry) => ({ itemSeq: entry.seq, tokens: tokensOf(stringsOf(entry.item).join('\n')) })),
          ...segments.map((segment) => ({ ...segment, itemSeq: event.nextItemSeq })),
        ];
        nextItemSeq = event.nextItemSeq + 1;
        break;
      case 'model.responded': {
        const step = [tokensOf(stepTextOf(event.response.output))];
        const earlier = [permanent, ...segments.map((segment) => segment.tokens)];
        injected.forEach((item, index) => {
          if (credited.has(index) || event.seq < item.fromSeq) return;
          if (identifiers[index]?.some((identifier) => occursIn(step, identifier) && !occursIn(earlier, identifier)) === true) credited.add(index);
        });
        for (const output of event.response.output) retain(stringsOf(output).join('\n'));
        break;
      }
      default:
        break;
    }
  }

  return injected.map((item, index) => ({ kind: item.kind, id: item.id, contributed: credited.has(index) }));
};
