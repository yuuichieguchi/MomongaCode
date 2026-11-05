import { describe, expect, it } from 'vitest';
import { createProgressGate } from '../../src/memory/progress-gate.ts';
import { JOURNAL_PROGRESS_INTERVAL_MS, JOURNAL_THREAD_SILENCE_LIMIT_MS, JOURNAL_WORST_UNIT_MS } from '../../src/memory/journal-thread-limits.ts';

describe('the progress gate of the journal thread', () => {
  it('posts at most once per interval however many units pass, so the messages follow time and not the size of the journal', () => {
    let now = 0;
    let posts = 0;
    const gate = createProgressGate({ now: () => now, intervalMs: 1000, post: () => void (posts += 1) });

    for (let unit = 0; unit < 100_000; unit += 1) gate.unit();
    expect(posts).toBe(0);

    for (let elapsed = 0; elapsed < 10_000; elapsed += 1) {
      now += 1;
      gate.unit();
    }
    expect(posts).toBe(10);
  });

  it('posts at the first unit after the interval, even when a single unit took far longer than the interval', () => {
    let now = 0;
    let posts = 0;
    const gate = createProgressGate({ now: () => now, intervalMs: 1000, post: () => void (posts += 1) });

    now = 3500;
    gate.unit();

    expect(posts).toBe(1);
  });
});

describe('the silence limit of the journal thread', () => {
  it('covers the busy timeout of the database, the worst single unit and two progress intervals', () => {
    expect(JOURNAL_THREAD_SILENCE_LIMIT_MS).toBe(5000 + JOURNAL_WORST_UNIT_MS + 2 * JOURNAL_PROGRESS_INTERVAL_MS);
  });
});
