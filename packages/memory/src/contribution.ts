import { isRecord } from '@momonga/foundation';
import { escapeXmlAttribute } from '@momonga/protocol';
import type { ContributionKind, RunEvent } from '@momonga/protocol';

export type InjectedItem = { kind: ContributionKind; id: string; text: string; fromSeq: number; untilSeq?: number };

export type RenderedWorkingState = { seq: number; text: string };

export type ItemContribution = { kind: ContributionKind; id: string; contributed: boolean };

export const MIN_IDENTIFIER_BYTES = 6;

const RUNS = /[A-Za-z0-9_]+(?:[./-][A-Za-z0-9_]+)*|[^\u0000-\u007f]+/g;
const SEPARATORS = /[./-]/;
const HAS_LETTER = /\p{L}/u;
const WORD_SEGMENTER = new Intl.Segmenter('und', { granularity: 'word' });
const ENCODER = new TextEncoder();

type Tokens = ReadonlySet<string>;

type Segment = { itemSeq: number; text: string };

const WORD_CODE_ASCII_ONLY = /^[A-Za-z0-9_]+$/;
const COMPOUND_ASCII_ONLY = /^[A-Za-z0-9_]+(?:[./-][A-Za-z0-9_]+)+$/;
const NON_ASCII_ONLY = /^[^\u0000-\u007f]+$/;
const MAX_ASCII = 0x7f;

const isWordCode = (code: number): boolean => (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
const isSeparatorCode = (code: number): boolean => code === 46 || code === 47 || code === 45;

export const CHUNK_CHARS = 1_048_576;

export const SEGMENTS_PER_UNIT = 4096;

const isTokenCode = (code: number): boolean => isWordCode(code) || isSeparatorCode(code) || code > MAX_ASCII;

const chunkEnd = (text: string, start: number): number => {
  const target = start + CHUNK_CHARS;
  if (target >= text.length) return text.length;
  for (let index = target; index < text.length; index += 1) if (!isTokenCode(text.charCodeAt(index))) return index;
  return text.length;
};

const addTokens = (tokens: Set<string>, text: string, unit: (() => void) | undefined): void => {
  for (const [run] of text.matchAll(RUNS)) {
    if (run.charCodeAt(0) < 0x80) {
      tokens.add(run);
      for (const word of run.split(SEPARATORS)) tokens.add(word);
    } else {
      let segments = 0;
      for (const { segment, isWordLike } of WORD_SEGMENTER.segment(run)) {
        if (isWordLike === true) tokens.add(segment);
        segments += 1;
        if (segments % SEGMENTS_PER_UNIT === 0) unit?.();
      }
    }
  }
};

export const tokensOf = (text: string, unit?: () => void): Tokens => {
  const tokens = new Set<string>();
  for (let start = 0; start < text.length; ) {
    const end = chunkEnd(text, start);
    addTokens(tokens, text.slice(start, end), unit);
    start = end;
    unit?.();
  }
  return tokens;
};

const utf8Bytes = (text: string): number => ENCODER.encode(text).length;

const someToken = (tokens: Tokens, test: (token: string) => boolean): boolean => {
  for (const token of tokens) if (test(token)) return true;
  return false;
};

const stringsOf = (value: unknown): string[] =>
  typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(stringsOf) : isRecord(value) ? Object.values(value).flatMap(stringsOf) : [];

const isPath = (identifier: string): boolean => identifier.includes('/');

const identifiersOf = (item: InjectedItem): string[] => {
  const own = [...tokensOf(item.text)].filter(
    (token) => isPath(token) || (!SEPARATORS.test(token) && utf8Bytes(token) >= MIN_IDENTIFIER_BYTES && HAS_LETTER.test(token)),
  );
  return [...new Set([...own, item.id])];
};

export const occursIn = (sets: readonly Tokens[], identifier: string): boolean =>
  isPath(identifier)
    ? sets.some((tokens) => someToken(tokens, (token) => token === identifier || token.endsWith(`/${identifier}`)))
    : sets.some((tokens) => tokens.has(identifier));

const asciiOccurrenceHolds = (text: string, start: number, identifier: string, kind: 'word' | 'compound'): boolean => {
  const end = start + identifier.length;
  const previous = start === 0 ? -1 : text.charCodeAt(start - 1);
  const next = end >= text.length ? -1 : text.charCodeAt(end);
  if (kind === 'word') return !isWordCode(previous) && !isWordCode(next);
  const nextEnds = !isWordCode(next) && !(isSeparatorCode(next) && end + 1 < text.length && isWordCode(text.charCodeAt(end + 1)));
  if (!nextEnds || isWordCode(previous)) return false;
  const continuesChunk = isSeparatorCode(previous) && start >= 2 && isWordCode(text.charCodeAt(start - 2));
  return !continuesChunk || (previous === 47 && isPath(identifier));
};

const NON_ASCII_RUNS = /[^\u0000-\u007f]+/g;

const nonAsciiChunkHolds = (chunk: string, identifier: string, unit: (() => void) | undefined): boolean => {
  for (const [run] of chunk.matchAll(NON_ASCII_RUNS)) {
    if (!run.includes(identifier)) continue;
    let segments = 0;
    for (const { segment, isWordLike } of WORD_SEGMENTER.segment(run)) {
      if (isWordLike === true && segment === identifier) return true;
      segments += 1;
      if (segments % SEGMENTS_PER_UNIT === 0) unit?.();
    }
  }
  return false;
};

const asciiChunkHolds = (text: string, from: number, identifier: string, kind: 'word' | 'compound'): boolean => {
  const window = text.slice(from, from + CHUNK_CHARS + identifier.length - 1);
  for (let local = window.indexOf(identifier); local >= 0 && local < CHUNK_CHARS; local = window.indexOf(identifier, local + 1)) {
    if (asciiOccurrenceHolds(text, from + local, identifier, kind)) return true;
  }
  return false;
};

export const hasToken = (text: string, identifier: string, unit?: () => void): boolean => {
  const kind = WORD_CODE_ASCII_ONLY.test(identifier) ? 'word' : COMPOUND_ASCII_ONLY.test(identifier) ? 'compound' : NON_ASCII_ONLY.test(identifier) ? 'non-ascii' : undefined;
  if (kind === undefined) return false;
  if (kind === 'non-ascii') {
    for (let start = 0; start < text.length; ) {
      const end = chunkEnd(text, start);
      unit?.();
      if (nonAsciiChunkHolds(text.slice(start, end), identifier, unit)) return true;
      start = end;
    }
    return false;
  }
  for (let from = 0; from < text.length; from += CHUNK_CHARS) {
    unit?.();
    if (asciiChunkHolds(text, from, identifier, kind)) return true;
  }
  return false;
};

const stepTextOf = (output: readonly unknown[]): string =>
  output
    .flatMap((item): string[] => {
      if (!isRecord(item)) return [];
      if (item['type'] === 'function_call') return typeof item['arguments'] === 'string' ? [item['arguments']] : [];
      if (item['type'] !== 'message' || !Array.isArray(item['content'])) return [];
      return item['content'].flatMap((part: unknown) => (isRecord(part) && typeof part['text'] === 'string' ? [part['text']] : []));
    })
    .join('\n');

const jsonWordsOf = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(jsonWordsOf)
      : isRecord(value)
        ? Object.entries(value).flatMap(([key, entry]) => [key, ...jsonWordsOf(entry)])
        : [];

const pinnedLayersOf = (body: unknown): string[] => {
  if (!isRecord(body) || !Array.isArray(body['input'])) throw new Error('a model.requested event holds a body without an input list');
  const messages = body['input'].flatMap((entry: unknown): string[] =>
    isRecord(entry) && entry['type'] === 'message' && (entry['role'] === 'system' || entry['role'] === 'developer') ? [stringsOf(entry['content']).join('\n')] : [],
  );
  return body['tools'] === undefined ? messages : [...messages, jsonWordsOf(body['tools']).join('\n')];
};

const regexSource = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const withoutInjectedBlocks = (layer: string, injected: readonly InjectedItem[], unit: (() => void) | undefined): string =>
  injected.reduce((rest, item) => {
    unit?.();
    if (item.kind === 'memory') return rest.replace(new RegExp(`<memory id="${regexSource(escapeXmlAttribute(item.id))}"[^>]*>[^<]*</memory>`, 'g'), '');
    if (item.kind === 'governing') return rest.replace(new RegExp(`(^|\\n)\\[${regexSource(item.id)}\\] [^\\n]*?: ${regexSource(item.text)}(?=\\n|$)`, 'g'), '$1');
    return rest;
  }, layer);

const ownerOf = (item: InjectedItem): string => (item.kind === 'summary' ? item.id : item.kind === 'working_state' ? item.kind : '');

type OnScreen = { owner: string; text: string };

export const measureContribution = ({
  events,
  task,
  injected,
  workingStates = [],
  unit,
}: {
  events: readonly RunEvent[];
  task: string;
  injected: readonly InjectedItem[];
  workingStates?: readonly RenderedWorkingState[];
  unit?: () => void;
}): ItemContribution[] => {
  const identifiers = injected.map(identifiersOf);
  const credited = new Set<number>();
  const renderedAt = new Map(workingStates.map((state) => [state.seq, state.text]));
  const pinned: string[] = [];
  const pinnedSeen = new Set<string>();
  let segments: Segment[] = [];
  let summaryOnScreen: OnScreen | undefined;
  let workingStateOnScreen: string | undefined;
  let nextItemSeq = 1;

  const retain = (text: string): void => {
    segments.push({ itemSeq: nextItemSeq, text });
    nextItemSeq += 1;
  };

  const pinLayers = (body: unknown): void => {
    for (const layer of pinnedLayersOf(body)) {
      if (pinnedSeen.has(layer)) continue;
      pinnedSeen.add(layer);
      pinned.push(withoutInjectedBlocks(layer, injected, unit));
    }
  };

  const retainedBefore = (identifier: string, owner: string): boolean => {
    if (hasToken(task, identifier, unit)) return true;
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      unit?.();
      if (hasToken((segments[index] as Segment).text, identifier, unit)) return true;
    }
    if (summaryOnScreen !== undefined && summaryOnScreen.owner !== owner && hasToken(summaryOnScreen.text, identifier, unit)) return true;
    if (workingStateOnScreen !== undefined && owner !== 'working_state' && hasToken(workingStateOnScreen, identifier, unit)) return true;
    return pinned.some((layer) => {
      unit?.();
      return hasToken(layer, identifier, unit);
    });
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
        summaryOnScreen = { owner: `summary-${event.seq}`, text: event.summary };
        workingStateOnScreen = renderedAt.get(event.seq);
        break;
      case 'model.requested':
        pinLayers(event.body);
        break;
      case 'context.inherited':
        segments = [
          ...event.history.map((entry) => ({ itemSeq: entry.seq, text: stringsOf(entry.item).join('\n') })),
          ...segments.map((segment) => ({ ...segment, itemSeq: event.nextItemSeq })),
        ];
        nextItemSeq = event.nextItemSeq + 1;
        break;
      case 'model.responded': {
        const step = [tokensOf(stepTextOf(event.response.output), unit)];
        const known = new Map<string, boolean>();
        const isNew = (identifier: string, owner: string): boolean => {
          const key = `${owner}\n${identifier}`;
          const cached = known.get(key);
          if (cached !== undefined) return cached;
          const fresh = occursIn(step, identifier) && !retainedBefore(identifier, owner);
          known.set(key, fresh);
          return fresh;
        };
        injected.forEach((item, index) => {
          if (credited.has(index) || event.seq < item.fromSeq || (item.untilSeq !== undefined && event.seq >= item.untilSeq)) return;
          const owner = ownerOf(item);
          if (identifiers[index]?.some((identifier) => isNew(identifier, owner)) === true) credited.add(index);
        });
        for (const output of event.response.output) retain(stringsOf(output).join('\n'));
        break;
      }
      default:
        break;
    }
    unit?.();
  }

  const reported = new Map<string, ItemContribution>();
  injected.forEach((item, index) => {
    const key = `${item.kind}\n${item.id}`;
    const earlier = reported.get(key);
    reported.set(key, { kind: item.kind, id: item.id, contributed: credited.has(index) || earlier?.contributed === true });
  });
  return [...reported.values()];
};
