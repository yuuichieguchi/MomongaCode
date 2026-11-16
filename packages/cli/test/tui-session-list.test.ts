import { describe, expect, it } from 'vitest';
import type { RunView, SessionView } from '../src/client/views.ts';
import type { RunEventFrame } from '../src/client/runtime-client.ts';
import { SESSION_READS_AT_ONCE, listedSessions } from '../src/tui/session-list.ts';
import type { SessionReads } from '../src/tui/session-list.ts';
import { SESSION, runView } from './fake-backend.ts';
import { frame } from './tui-harness.tsx';

const CWD = '/work/project';

const stored = (count: number): SessionView[] => Array.from({ length: count }, (_, index) => ({ ...SESSION, id: `s${index}`, cwd: CWD, createdAt: 100 + index, latestRunId: `r${index}` }));

const gatedReads = (sessions: readonly SessionView[]) => {
  const started: string[] = [];
  const gates = new Map<string, PromiseWithResolvers<void>>();
  const awaited: { count: number; reached: PromiseWithResolvers<void> }[] = [];
  let reading = 0;
  let most = 0;
  const gateOf = (sessionId: string): PromiseWithResolvers<void> => {
    const gate = gates.get(sessionId) ?? Promise.withResolvers<void>();
    gates.set(sessionId, gate);
    return gate;
  };
  const reads: SessionReads = {
    listSessions: async () => [...sessions],
    listRuns: async (sessionId): Promise<RunView[]> => {
      started.push(sessionId);
      reading += 1;
      most = Math.max(most, reading);
      for (const wait of awaited) if (started.length >= wait.count) wait.reached.resolve();
      await gateOf(sessionId).promise;
      reading -= 1;
      return [runView({ id: `second-${sessionId}`, sessionId, ordinal: 2 }), runView({ id: `first-${sessionId}`, sessionId, ordinal: 1 }), runView({ id: `child-${sessionId}`, sessionId, ordinal: 3, parentRunId: `first-${sessionId}` })];
    },
    streamEvents: async function* (runId): AsyncGenerator<RunEventFrame> {
      yield frame({ type: 'user.message', text: `prompt of ${runId}` });
    },
  };
  const startedAtLeast = (count: number): Promise<void> => {
    const reached = Promise.withResolvers<void>();
    if (started.length >= count) reached.resolve();
    else awaited.push({ count, reached });
    return reached.promise;
  };
  return { reads, started, startedAtLeast, mostAtOnce: (): number => most, release: (sessionId: string): void => gateOf(sessionId).resolve() };
};

describe('the sessions /resume lists (cli-tui-23)', () => {
  it('reads the sessions of a batch together and never more than the bound at once', async () => {
    const sessions = stored(SESSION_READS_AT_ONCE + 2);
    const { reads, started, startedAtLeast, mostAtOnce, release } = gatedReads(sessions);
    const listing = listedSessions(reads, CWD, undefined, new AbortController().signal);
    await startedAtLeast(SESSION_READS_AT_ONCE);
    expect(started).toHaveLength(SESSION_READS_AT_ONCE);
    for (const id of started.slice()) release(id);
    await startedAtLeast(sessions.length);
    expect(started).toHaveLength(sessions.length);
    for (const session of sessions) release(session.id);
    const listed = await listing;
    expect(mostAtOnce()).toBe(SESSION_READS_AT_ONCE);
    expect(listed.map((session) => session.id)).toEqual(sessions.map((session) => session.id).reverse());
  });

  it('gives each session its first prompt and the count of its own runs, newest first, without the open session and the ones with no run', async () => {
    const sessions = [...stored(3), { ...SESSION, id: 'empty', cwd: CWD, createdAt: 500, latestRunId: null }];
    const { reads, release } = gatedReads(sessions);
    for (const session of sessions) release(session.id);
    expect(await listedSessions(reads, CWD, 's1', new AbortController().signal)).toEqual([
      { id: 's2', createdAt: 102, runs: 2, firstPrompt: 'prompt of first-s2' },
      { id: 's0', createdAt: 100, runs: 2, firstPrompt: 'prompt of first-s0' },
    ]);
  });
});

describe('the title of a listed session (real-use-24)', () => {
  it('is the first message the person wrote, not a command such as /compact that started the first run', async () => {
    const prompts: Readonly<Record<string, string>> = { 'r-1': '/compact', 'r-2': 'remember the codeword banana' };
    const reads: SessionReads = {
      listSessions: async () => [{ ...SESSION, id: 's1', cwd: CWD, createdAt: 100, latestRunId: 'r-2' }],
      listRuns: async (sessionId) => [runView({ id: 'r-1', sessionId, ordinal: 1 }), runView({ id: 'r-2', sessionId, ordinal: 2 })],
      streamEvents: async function* (runId): AsyncGenerator<RunEventFrame> {
        yield frame({ type: 'user.message', text: prompts[runId] ?? '' });
      },
    };
    const [listed] = await listedSessions(reads, CWD, undefined, new AbortController().signal);
    expect(listed?.firstPrompt).toBe('remember the codeword banana');
  });
});
