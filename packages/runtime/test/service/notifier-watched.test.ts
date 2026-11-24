import { describe, expect, it } from 'vitest';
import { createRunNotifier } from '../../src/service/notifier.ts';

type WatchedQuery = { watchedSessionIds(): string[] };

const notifierWithQuery = () => {
  const notifier = createRunNotifier();
  return Object.assign(notifier, { watchedSessionIds: (notifier as unknown as WatchedQuery).watchedSessionIds });
};

describe('the sessions with a watcher', () => {
  it('starts with none', () => {
    expect(notifierWithQuery().watchedSessionIds()).toEqual([]);
  });

  it('names every session with at least one watcher, once each, and no session watched only through its runs', () => {
    const notifier = notifierWithQuery();
    notifier.watchSession('s1', () => undefined);
    notifier.watchSession('s1', () => undefined);
    notifier.watchSession('s2', () => undefined);
    notifier.watchRun('r1', () => undefined);
    notifier.subscribe(() => undefined);
    expect(notifier.watchedSessionIds().sort()).toEqual(['s1', 's2']);
  });

  it('keeps a session while one of its watchers remains and drops it when the last one leaves', () => {
    const notifier = notifierWithQuery();
    const first = notifier.watchSession('s1', () => undefined);
    const second = notifier.watchSession('s1', () => undefined);
    const other = notifier.watchSession('s2', () => undefined);
    first();
    expect(notifier.watchedSessionIds().sort()).toEqual(['s1', 's2']);
    second();
    expect(notifier.watchedSessionIds()).toEqual(['s2']);
    second();
    expect(notifier.watchedSessionIds()).toEqual(['s2']);
    other();
    expect(notifier.watchedSessionIds()).toEqual([]);
  });

  it('counts a session watched again after it was dropped', () => {
    const notifier = notifierWithQuery();
    notifier.watchSession('s1', () => undefined)();
    notifier.watchSession('s1', () => undefined);
    expect(notifier.watchedSessionIds()).toEqual(['s1']);
  });
});
