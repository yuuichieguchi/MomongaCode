import { describe, expect, it } from 'vitest';
import { SWITCH_CHUNK_ROWS } from '../../src/tui/screen/constants.ts';
import { createHistoryFeed } from '../../src/tui/screen/history-feed.ts';
import { createRowCache as createRowCacheWith } from '../../src/tui/screen/row-cache.ts';
import { createTranscriptStore } from '../../src/tui/screen/store.ts';
import { sourceOf } from '../../src/tui/screen/viewport.ts';
import { appendEntry, foldEvent } from '../../src/tui/transcript.ts';
import { eventOf, ROW_RENDERERS, ROW_SCHEDULE } from './screen-fakes.ts';

const createRowCache = (renderers: Parameters<typeof createRowCacheWith>[0] = ROW_RENDERERS) => createRowCacheWith(renderers, ROW_SCHEDULE);

describe('the history feed', () => {
  it('hands the settled rows over once, in order, in chunks of at most 200 rows', () => {
    expect(SWITCH_CHUNK_ROWS).toBe(200);
    const store = createTranscriptStore();
    for (let index = 0; index < 450; index += 1) appendEntry(store, { kind: 'info', text: `line ${index}` });
    const source = sourceOf(store, createRowCache(), 40);
    const feed = createHistoryFeed();
    const chunks: string[][] = [];
    while (feed.pending(source, store.settledAt)) chunks.push(feed.next(source, store.settledAt).map((row) => row.text));
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
    while (feed.pending(source, store.settledAt)) chunks.push(feed.next(source, store.settledAt).map((row) => row.text));
    expect(chunks.map((chunk) => chunk.length)).toEqual([200, 200, 51]);
    expect(chunks.flat().at(-1)).toBe('after');
  });

  it('hands an entry over when it has settled, and an entry that can still change holds back no later settled entry', () => {
    const store = createTranscriptStore();
    appendEntry(store, { kind: 'info', text: 'done' });
    foldEvent(store, eventOf({ type: 'agent.message.delta', attempt: 0, itemId: 'a', text: 'open' }));
    const source = sourceOf(store, createRowCache(), 40);
    const feed = createHistoryFeed();
    expect(feed.next(source, store.settledAt).map((row) => row.text)).toEqual(['done']);
    expect(feed.pending(source, store.settledAt)).toBe(false);
    appendEntry(store, { kind: 'info', text: 'later' });
    expect(feed.pending(source, store.settledAt)).toBe(true);
    expect(feed.next(source, store.settledAt).map((row) => row.text)).toEqual(['open', 'later']);
  });

  it('hands the settled answers after an open plan to the scrollback and keeps the plan in the live rows', () => {
    const store = createTranscriptStore();
    appendEntry(store, { kind: 'info', text: 'before' });
    appendEntry(store, { kind: 'plan', entries: [{ content: 'step one', status: 'in_progress', priority: 'medium' }] }, 'plan');
    appendEntry(store, { kind: 'info', text: 'first answer' });
    appendEntry(store, { kind: 'info', text: 'second answer' });
    const source = sourceOf(store, createRowCache(), 40);
    const feed = createHistoryFeed();
    const handed: string[] = [];
    while (feed.pending(source, store.settledAt)) handed.push(...feed.next(source, store.settledAt).map((row) => row.text));
    expect(handed).toEqual(['before', 'first answer', 'second answer']);
    expect(feed.live(source, store.settledAt).map((row) => row.text).join('\n')).toContain('step one');
    expect(feed.live(source, store.settledAt).map((row) => row.text)).not.toContain('first answer');
  });

  it('hands every entry over once, however often it is asked', () => {
    const store = createTranscriptStore();
    const source = sourceOf(store, createRowCache(), 40);
    const feed = createHistoryFeed();
    const handed: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      appendEntry(store, { kind: 'info', text: `line ${index}` });
      if (index % 3 === 0) appendEntry(store, { kind: 'plan', entries: [{ content: `step ${index}`, status: 'pending', priority: 'low' }] }, 'plan');
      for (let ask = 0; ask < 3; ask += 1) handed.push(...feed.next(source, store.settledAt).map((row) => row.text));
    }
    const lines = handed.filter((text) => text.startsWith('line '));
    expect(lines).toEqual(Array.from({ length: 30 }, (_, index) => `line ${index}`));
  });
});
