import { afterEach, describe, expect, it, vi } from 'vitest';
import { listJobs } from '../src/commands/jobs.ts';
import { showReport } from '../src/commands/report.ts';
import { activeRunIdOf, latestRunIdOf } from '../src/commands/targets.ts';
import { continuedSession } from '../src/run/resolve-session.ts';
import { startRealRuntime } from './real-runtime.ts';
import type { RealRuntime } from './real-runtime.ts';

vi.mock('../src/daemon/ensure-daemon.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/daemon/ensure-daemon.ts')>()),
  ensureCurrentDaemon: async () => ({}),
  ensureDaemon: async () => ({}),
}));

const opened: RealRuntime[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((runtime) => runtime.client.close()));
});

const olderSessionWithNewerRun = async () => {
  const runtime = await startRealRuntime();
  opened.push(runtime);
  const { service } = runtime;
  const older = await service.createSession();
  service.clock.advance(1000);
  const newer = await service.createSession();
  service.clock.advance(1000);
  const runOfNewer = await service.createRun(newer.id);
  service.clock.advance(1000);
  const runOfOlder = await service.createRun(older.id);
  return { runtime, older, newer, runOfNewer, runOfOlder };
};

describe('the latest run of a folder is the run made last, whichever session it belongs to', () => {
  it('the session list carries the time of the active and of the latest run of each session', async () => {
    const { runtime, older, newer, runOfNewer, runOfOlder } = await olderSessionWithNewerRun();

    const sessions = await runtime.client.listSessions(runtime.service.layout.project);

    expect(sessions.find((session) => session.id === older.id)).toMatchObject({ latestRunId: runOfOlder.id, latestRunAt: runOfOlder.createdAt, activeRunId: runOfOlder.id, activeRunAt: runOfOlder.createdAt });
    expect(sessions.find((session) => session.id === newer.id)).toMatchObject({ latestRunId: runOfNewer.id, latestRunAt: runOfNewer.createdAt });
    expect(runOfOlder.createdAt).toBeGreaterThan(runOfNewer.createdAt);
    expect((await runtime.client.getSession(newer.id)).latestRunAt).toBe(runOfNewer.createdAt);
    const empty = await runtime.service.createSession();
    expect(await runtime.client.getSession(empty.id)).toMatchObject({ latestRunId: null, latestRunAt: null, activeRunId: null, activeRunAt: null });
  });

  it('the selectors of report, trace, status and attach, and of cancel and approve, name the run of the older session', async () => {
    const { runtime, runOfOlder } = await olderSessionWithNewerRun();

    expect(await latestRunIdOf(runtime.client, runtime.service.layout.project)).toBe(runOfOlder.id);
    expect(await activeRunIdOf(runtime.client, runtime.service.layout.project)).toBe(runOfOlder.id);
  });

  it('report without an id shows that run, and jobs without an id lists the session of that run', async () => {
    const { runtime, older, runOfOlder } = await olderSessionWithNewerRun();

    expect(await showReport(runtime.ports, runtime.paths, undefined, true)).toBe(0);
    expect(JSON.parse(runtime.stdout.join(''))).toMatchObject({ runId: runOfOlder.id });
    runtime.stdout.length = 0;
    expect(await listJobs(runtime.ports, runtime.paths, undefined, false)).toBe(0);
    expect(runtime.stdout.join('')).toBe(`session ${older.id} has no background jobs\n`);
  });

  it('--continue reopens the session worked in last', async () => {
    const { runtime, older } = await olderSessionWithNewerRun();

    expect((await continuedSession(runtime.client, runtime.service.layout.project)).id).toBe(older.id);
  });
});
