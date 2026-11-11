import { describe, expect, it } from 'vitest';
import type { RuntimeStore } from '@momonga/store';
import { expectError, startService } from './helpers.ts';

type StoreReads = { listRuns: number; sessionPages: { limit: number; cursor: string | null }[] };

const countingStore = (reads: StoreReads) => (store: RuntimeStore): RuntimeStore => ({
  ...store,
  listRuns: (sessionId, statuses) => {
    reads.listRuns += 1;
    return store.listRuns(sessionId, statuses);
  },
  listSessions: (request) => {
    reads.sessionPages.push({ limit: request.limit, cursor: request.cursor });
    return store.listSessions(request);
  },
});

const serviceWithSessions = async (count: number) => {
  const reads: StoreReads = { listRuns: 0, sessionPages: [] };
  const env = await startService({ wrapStore: countingStore(reads) });
  const sessions: { id: string; runId: string }[] = [];
  for (let index = 0; index < count; index += 1) {
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    sessions.push({ id: session.id, runId: run.id });
    env.clock.advance(1);
  }
  reads.listRuns = 0;
  reads.sessionPages.length = 0;
  return { env, reads, sessions };
};

describe('GET /v1/sessions answers one page', () => {
  it('reads one page of sessions and no list of runs, and names the next page', async () => {
    const { env, reads, sessions } = await serviceWithSessions(3);

    const first = await env.http('GET', '/v1/sessions?limit=2');

    expect(first.status).toBe(200);
    expect(first.json.sessions.map((session: { id: string }) => session.id)).toEqual([sessions[0]?.id, sessions[1]?.id]);
    expect(first.json.sessions.map((session: { activeRunId: string; latestRunId: string }) => [session.activeRunId, session.latestRunId])).toEqual([
      [sessions[0]?.runId, sessions[0]?.runId],
      [sessions[1]?.runId, sessions[1]?.runId],
    ]);
    expect(typeof first.json.next).toBe('string');
    expect(reads).toEqual({ listRuns: 0, sessionPages: [{ limit: 2, cursor: null }] });

    const second = await env.http('GET', `/v1/sessions?limit=2&cursor=${encodeURIComponent(first.json.next)}`);

    expect(second.json.sessions.map((session: { id: string }) => session.id)).toEqual([sessions[2]?.id]);
    expect(second.json.next).toBeNull();
    expect(reads.listRuns).toBe(0);
  });

  it('pages the sessions of one folder the same way', async () => {
    const { env, sessions } = await serviceWithSessions(2);

    const first = await env.http('GET', `/v1/sessions?cwd=${encodeURIComponent(env.layout.project)}&limit=1`);

    expect(first.json.sessions.map((session: { id: string }) => session.id)).toEqual([sessions[0]?.id]);
    expect(typeof first.json.next).toBe('string');
  });

  it('refuses a limit outside the page size and a cursor this list did not give', async () => {
    const { env } = await serviceWithSessions(1);

    expectError(await env.http('GET', '/v1/sessions?limit=0'), 400, 'invalid_request');
    expectError(await env.http('GET', '/v1/sessions?limit=501'), 400, 'invalid_request');
    expectError(await env.http('GET', '/v1/sessions?limit=two'), 400, 'invalid_request');
    const refused = await env.http('GET', '/v1/sessions?cursor=nonsense');
    expectError(refused, 400, 'invalid_request');
    expect(refused.json.error.param).toBe('cursor');
  });
});

describe('the view of one session', () => {
  it('names its active and its latest run without reading the list of its runs', async () => {
    const { env, reads, sessions } = await serviceWithSessions(1);
    const [only] = sessions;
    if (only === undefined) throw new Error('the session was not created');

    const view = await env.http('GET', `/v1/sessions/${only.id}`);

    expect(view.json.session).toMatchObject({ id: only.id, activeRunId: only.runId, latestRunId: only.runId });
    expect(reads.listRuns).toBe(0);
  });
});

describe('the view of a run and its report', () => {
  it('never answers a report whose status is newer than the status of the view', async () => {
    let moveOn: (() => Promise<unknown>) | undefined;
    const env = await startService({
      wrapStore: (store) => ({
        ...store,
        journalFacts: {
          ...store.journalFacts,
          report: async (request, signal) => {
            await moveOn?.();
            return store.journalFacts.report(request, signal);
          },
        },
      }),
    });
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    moveOn = () => env.store.requestCancel(run.id);

    const answered = await env.http('GET', `/v1/runs/${run.id}`);

    expect(answered.json.run.report.status).toBe('CANCELLING');
    expect(answered.json.run.status).toBe(answered.json.run.report.status);
  });
});
