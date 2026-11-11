import { describe, expect, it } from 'vitest';
import type { RuntimeStore, Session } from '@momonga/store';
import { enqueue, harness, mustClaim, newSession, rawDb } from './helpers.ts';

const SESSIONS = 500;
const PAGE = 50;

const everyPage = (store: RuntimeStore, filter: { cwd?: string } = {}) => {
  const pages: ReturnType<RuntimeStore['listSessions']>[] = [];
  let cursor: string | null = null;
  do {
    const page = store.listSessions({ ...filter, limit: PAGE, cursor });
    pages.push(page);
    cursor = page.next;
  } while (cursor !== null);
  return pages;
};

const manySessions = async () => {
  const env = harness();
  const made: Session[] = [];
  for (let index = 0; index < SESSIONS; index += 1) {
    made.push(newSession(env.store, index % 2 === 0 ? '/work/a' : '/work/b'));
    if (index % 7 === 0) env.clock.advance(1);
  }
  return { ...env, made };
};

describe('the sessions are listed a page at a time', () => {
  it('answers one page of the asked size and a cursor, and every session once across the pages, in the order they were made', async () => {
    const { store, made } = await manySessions();

    const pages = everyPage(store);

    expect(pages).toHaveLength(SESSIONS / PAGE);
    expect(pages.slice(0, -1).every((page) => page.sessions.length === PAGE && page.next !== null)).toBe(true);
    expect(pages.at(-1)?.next).toBeNull();
    expect(pages.flatMap((page) => page.sessions.map((session) => session.id))).toEqual(made.map((session) => session.id));
  });

  it('pages the sessions of one folder', async () => {
    const { store, made } = await manySessions();

    const pages = everyPage(store, { cwd: '/work/b' });

    expect(pages.flatMap((page) => page.sessions.map((session) => session.id))).toEqual(made.filter((session) => session.cwd === '/work/b').map((session) => session.id));
  });

  it('gives each session of a page its active run and its latest run', async () => {
    const { store } = harness();
    const idle = newSession(store);
    const finished = newSession(store);
    const busy = newSession(store);
    const done = await enqueue(store, finished.id, 'done');
    expect((await store.transition(mustClaim(store, 'w1'), ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
    const working = await enqueue(store, busy.id, 'working');

    const { sessions } = store.listSessions({ limit: PAGE, cursor: null });

    expect(sessions.map(({ id, activeRunId, latestRunId }) => ({ id, activeRunId, latestRunId }))).toEqual([
      { id: idle.id, activeRunId: null, latestRunId: null },
      { id: finished.id, activeRunId: null, latestRunId: done.id },
      { id: busy.id, activeRunId: working.id, latestRunId: working.id },
    ]);
  });

  it('reads a page through an index in the order of the page, with no sort of all sessions', async () => {
    const { dbPath } = await manySessions();
    const db = rawDb(dbPath);
    const indexes = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sessions'").all().map((row) => String(row['sql']));

    expect(indexes).toEqual(expect.arrayContaining([expect.stringMatching(/ON sessions \(created_at, id\)/), expect.stringMatching(/ON sessions \(cwd, created_at, id\)/)]));
  });

  it('refuses a cursor it did not give', async () => {
    const { store } = harness();

    expect(() => store.listSessions({ limit: PAGE, cursor: 'not a cursor' })).toThrow(/cursor/);
  });
});
