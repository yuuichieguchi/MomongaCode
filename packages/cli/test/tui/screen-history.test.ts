import { describe, expect, it } from 'vitest';
import { SWITCH_CHUNK_ROWS } from '../../src/tui/screen/constants.ts';
import { createHistoryFeed } from '../../src/tui/screen/history-feed.ts';
import { createRowCache as createRowCacheWith } from '../../src/tui/screen/row-cache.ts';
import { createTranscriptStore } from '../../src/tui/screen/store.ts';
import { sourceOf } from '../../src/tui/screen/viewport.ts';
import { appendEntry, foldEvent } from '../../src/tui/transcript.ts';
import { eventOf, ROW_RENDERERS } from './screen-fakes.ts';

const createRowCache = (renderers: Parameters<typeof createRowCacheWith>[0] = ROW_RENDERERS) => createRowCacheWith(renderers);

describe('the history feed', () => {
  it('hands the settled rows over once, in order, in chunks of at most 200 rows', () => {
    expect(SWITCH_CHUNK_ROWS).toBe(200);
    const store = createTranscriptStore();
    for (let index = 0; index < 450; index += 1) appendEntry(store, { kind: 'info', text: `line ${index}` });
    const source = sourceOf(store, createRowCache(), 40);
    const feed = createHistoryFeed();
    const chunks: string[][] = [];
    while (feed.pending(store.settledCount())) chunks.push(feed.next(source, store.settledCount()).map((row) => row.text));
    expect(chunks.map((chunk) => chunk.length)).toEqual([200, 200, 50]);
    expect(chunks.flat()).toEqual(Array.from({ length: 450 }, (_, index) => `line ${index}`));
    expect(feed.handed()).toBe(450);
  });

  it('cuts an entry longer than a chunk across chunks without losing or repeating a row', () => {
    const store = createTranscriptStore();
    appendEntry(store, { kind: 'info', text: Array.from({ length: 450 }, (_, index) => `row ${index}`).join('\n') });
    appendEntry(store, { kind: 'info', text: 'after' });
    const source = sourceOf(store, createRowCache(), 40);
    const feed = createHistoryFeed();
    const chunks: string[][] = [];
    while (feed.pending(store.settledCount())) chunks.push(feed.next(source, store.settledCount()).map((row) => row.text));
    expect(chunks.map((chunk) => chunk.length)).toEqual([200, 200, 51]);
    expect(chunks.flat().at(-1)).toBe('after');
  });

  it('waits at the first entry that can still change and goes on when it has settled', () => {
    const store = createTranscriptStore();
    appendEntry(store, { kind: 'info', text: 'done' });
    foldEvent(store, eventOf({ type: 'agent.message.delta', attempt: 0, itemId: 'a', text: 'open' }));
    const source = sourceOf(store, createRowCache(), 40);
    const feed = createHistoryFeed();
    expect(feed.next(source, store.settledCount()).map((row) => row.text)).toEqual(['done']);
    expect(feed.pending(store.settledCount())).toBe(false);
    appendEntry(store, { kind: 'info', text: 'later' });
    expect(feed.pending(store.settledCount())).toBe(true);
    expect(feed.next(source, store.settledCount()).map((row) => row.text)).toEqual(['open', 'later']);
  });
});
