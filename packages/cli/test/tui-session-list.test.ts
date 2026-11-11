import { describe, expect, it } from 'vitest';
import type { RunView, SessionView } from '../src/client/views.ts';
import type { RunEventFrame } from '../src/client/runtime-client.ts';
import { SESSION_READS_AT_ONCE, listedSessions } from '../src/tui/session-list.ts';
import type { SessionReads } from '../src/tui/session-list.ts';
import { SESSION, runView } from './fake-backend.ts';
import { frame } from './tui-harness.tsx';
import { waitFor } from '@momonga/testkit';

const CWD = '/work/project';

const stored = (count: number): SessionView[] => Array.from({ length: count }, (_, index) => ({ ...SESSION, id: `s${index}`, cwd: CWD, createdAt: 100 + index, latestRunId: `r${index}` }));

const gatedReads = (sessions: readonly SessionView[]) => {
  const started: string[] = [];
  let reading = 0;
  let mostAtOnce = 0;
  const gates = new Map<string, PromiseWithResolvers<void>>();
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
      mostAtOnce = Math.max(mostAtOnce, reading);
      await gateOf(sessionId).promise;
      reading -= 1;
      return [runView({ id: `second-${sessionId}`, sessionId, ordinal: 2 }), runView({ id: `first-${sessionId}`, sessionId, ordinal: 1 }), runView({ id: `child-${sessionId}`, sessionId, ordinal: 3, parentRunId: `first-${sessionId}` })];
    },
    streamEvents: async function* (runId): AsyncGenerator<RunEventFrame> {
      yield frame({ type: 'user.message', text: `prompt of ${runId}` });
    },
  };
  return { reads, started, mostAtOnce: () => mostAtOnce, release: (sessionId: string): void => gateOf(sessionId).resolve() };
};

describe('the sessions /resume lists (cli-tui-23)', () => {
  it('reads the sessions of a batch together and never more than the bound at once', async () => {
    const sessions = stored(SESSION_READS_AT_ONCE + 2);
    const { reads, started, mostAtOnce, release } = gatedReads(sessions);
    const listing = listedSessions(reads, CWD, undefined, new AbortController().signal);
    await waitFor(() => started.length === SESSION_READS_AT_ONCE, { description: 'the first batch of session reads' });
    for (const id of started.slice()) release(id);
    await waitFor(() => started.length === sessions.length, { description: 'the reads of the rest of the sessions' });
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
