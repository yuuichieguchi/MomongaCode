import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EXIT_RETIRED, FIRST_GENERATION, createRolePort, generationLayout, momongaLayout, publishCurrentGeneration, scopeToGeneration } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, testKernelLock } from '@momonga/testkit';
import { mutableRole } from '../shared/mutable-role.ts';
import { makeLogger } from '../process/helpers.ts';
import { RUNTIME_VERSION, launchRuntime, prepareGeneration, readDb, scopedPaths, startStack, waitForCondition, waitForStatus } from '../process/run-helpers.ts';
import type { RunHome } from '../process/run-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const MOVED_TEXT = 'This daemon has been replaced by a newer version and accepts no new work. The request was not run; send it again.';

const publish = async (temp: RunHome, generation: number): Promise<void> => {
  expect(await publishCurrentGeneration(temp.paths, { generation, version: RUNTIME_VERSION, sockets: generationLayout(temp.home, generation).sockets }, { lock: testKernelLock() })).toBe('published');
};

const runRow = (temp: RunHome, runId: string) =>
  readDb<{ status: string; attempts: number; failed_attempts: number; lease_owner: string | null; lease_generation: number | null }>(
    temp.paths.databases.runtime,
    'SELECT status, attempts, failed_attempts, lease_owner, lease_generation FROM runs WHERE id = ?',
    runId,
  )[0];

const eventCount = (temp: RunHome, runId: string, type: string): number =>
  readDb<{ n: number }>(temp.paths.databases.runtime, 'SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = ?', runId, type)[0]?.n ?? 0;

describe('the scoped paths of a generation (17.6, 20.4)', () => {
  it('puts the markers, the job output and the spawn scratch of generation 3 in its own directories and leaves the call locks, the store and the session scratch shared', () => {
    const base = momongaLayout('/home/user', 'darwin', {});
    const scoped = scopeToGeneration(base, 3);
    const other = scopeToGeneration(base, 4);

    expect(scoped.markers).toEqual({
      root: '/home/user/.momonga/run/markers/g3',
      tools: '/home/user/.momonga/run/markers/g3/tools',
      mcp: '/home/user/.momonga/run/markers/g3/mcp',
      targets: '/home/user/.momonga/run/markers/g3/targets',
      daemons: '/home/user/.momonga/run/markers/g3/daemons',
    });
    expect(scoped.jobs).toBe('/home/user/.momonga/run/g3/jobs');
    expect(scoped.tmp.spawn).toBe(path.join(base.tmp.spawn, 'g3'));
    expect(scoped.callLocks).toBe(base.callLocks);
    expect(scoped.callLocks).toBe('/home/user/.momonga/run/call-locks');
    expect(scoped.databases).toEqual(base.databases);
    expect(scoped.settingsFile).toBe(base.settingsFile);
    expect(scoped.tmp.sessions).toBe(base.tmp.sessions);
    for (const directory of [scoped.markers.tools, scoped.markers.mcp, scoped.jobs, scoped.tmp.spawn]) {
      expect([other.markers.tools, other.markers.mcp, other.jobs, other.tmp.spawn]).not.toContain(directory);
    }
  });
});

describe('the role of a runtime from run/current (17.1, 20.2)', () => {
  it('is starting until run/current names it, serving after, and retiring within a tick of a newer generation being named', async () => {
    const stack = await startStack();
    const logger = makeLogger();
    const launched = await launchRuntime(stack.temp, { logger, role: createRolePort({ paths: stack.temp.paths, generation: FIRST_GENERATION, logger }) });

    expect(launched.handle.role()).toBe('starting');
    expect((await launched.http('GET', '/v1/health')).json).toMatchObject({ state: 'running', role: 'starting', steps: 0, jobs: 0 });
    const refused = await launched.http('POST', '/v1/sessions', { body: { cwd: stack.temp.project, env: {} } });
    expect({ status: refused.status, code: refused.json.error.code, message: refused.json.error.message }).toEqual({ status: 503, code: 'moved', message: MOVED_TEXT });

    await publish(stack.temp, FIRST_GENERATION);
    await waitForCondition(() => launched.handle.role() === 'serving', 'the role tick to read run/current naming this generation');
    const session = await launched.createSession();
    const run = await launched.createRun(session.id);
    expect(await waitForStatus(stack.temp, run.id, ['COMPLETED', 'FAILED'])).toBe('COMPLETED');
    expect(runRow(stack.temp, run.id)).toMatchObject({ lease_owner: null, lease_generation: null, attempts: 1 });

    await prepareGeneration(stack.temp, 2);
    await publish(stack.temp, 2);
    await waitForCondition(() => launched.handle.role() === 'retiring', 'the role tick to read run/current naming a newer generation');
    await waitForCondition(() => logger.entries.some((entry) => entry.msg === 'generation.retired'), 'the retiring runtime, which holds nothing, to leave');
    expect(logger.entries.filter((entry) => entry.msg === 'generation.retiring')).toHaveLength(1);
    expect(await launched.handle.close()).toMatchObject({ clean: true, exitCode: EXIT_RETIRED });
  });
});

describe('the exit of a retiring runtime (17.1 "Exit", 20.1, 20.31)', () => {
  it('finishes the step in flight, exits only when it holds nothing, asks its entry to shut down once and closes with EXIT_RETIRED', async () => {
    const stack = await startStack();
    const role = mutableRole('serving');
    let shutdowns = 0;
    const launched = await launchRuntime(stack.temp, {
      role: role.port,
      requestShutdown: () => {
        shutdowns += 1;
      },
    });
    const hold = stack.hold();
    const session = await launched.createSession();
    const run = await launched.createRun(session.id);
    await hold.waitForRequest();

    role.set('retiring');
    await waitForCondition(() => launched.logger.entries.some((entry) => entry.msg === 'generation.retiring'), 'the retiring runtime to learn its role');
    expect((await launched.http('GET', '/v1/health')).json).toMatchObject({ state: 'retiring', role: 'retiring', steps: 1 });
    expect(shutdowns).toBe(0);

    hold.release();
    await waitForCondition(() => shutdowns === 1, 'the retiring runtime to ask for its shutdown once it holds nothing');
    const result = await launched.handle.close();

    expect(result).toEqual({ clean: true, abandoned: [], stragglers: [], exitCode: EXIT_RETIRED });
    expect(EXIT_RETIRED).toBe(79);
    expect(shutdowns).toBe(1);
    expect(eventCount(stack.temp, run.id, 'model.responded')).toBe(1);
    expect(stack.completions()).toBe(1);
    expect(eventCount(stack.temp, run.id, 'attempt.failed')).toBe(0);
    expect(runRow(stack.temp, run.id)).toMatchObject({ lease_owner: null, lease_generation: null, failed_attempts: 0 });
  });

  it('a user stop of a retiring runtime is the ordinary close, with no retire exit code', async () => {
    const stack = await startStack();
    const role = mutableRole('serving');
    const launched = await launchRuntime(stack.temp, { role: role.port });
    const hold = stack.hold();
    const session = await launched.createSession();
    await launched.createRun(session.id);
    await hold.waitForRequest();
    role.set('retiring');

    const closing = launched.handle.close();
    await waitForCondition(() => true, 'the close to begin');
    expect((await launched.http('GET', '/v1/health')).json).toMatchObject({ state: 'draining' });
    hold.release();

    expect(await closing).toEqual({ clean: true, abandoned: [], stragglers: [] });
  });
});

describe('two generations on one store (H1, 17.10)', () => {
  it('have their own sockets; in the lag window both may claim and every step still runs once; the retiring one then leaves and the serving one goes on', async () => {
    const stack = await startStack();
    const first = mutableRole('serving');
    const older = await launchRuntime(stack.temp, { role: first.port });
    const gatewaySocketPath = generationLayout(stack.temp.home, FIRST_GENERATION).sockets.gateway;
    const newer = await launchRuntime(stack.temp, { generation: 2, gatewaySocketPath });

    expect(older.handle.ready.socketPath).toBe(generationLayout(stack.temp.home, 1).sockets.runtime);
    expect(newer.handle.ready.socketPath).toBe(generationLayout(stack.temp.home, 2).sockets.runtime);

    const session = await newer.createSession();
    const run = await newer.createRun(session.id);
    expect(await waitForStatus(stack.temp, run.id, ['COMPLETED', 'FAILED'])).toBe('COMPLETED');
    expect(runRow(stack.temp, run.id)).toMatchObject({ attempts: 1, failed_attempts: 0 });
    expect(eventCount(stack.temp, run.id, 'model.responded')).toBe(stack.completions());

    first.set('retiring');
    await waitForCondition(() => older.logger.entries.some((entry) => entry.msg === 'generation.retired'), 'the retiring generation to leave');
    expect(await older.handle.close()).toMatchObject({ clean: true, exitCode: EXIT_RETIRED });

    const second = await newer.createRun(session.id, { input: 'Say hello again' });
    expect(await waitForStatus(stack.temp, second.id, ['COMPLETED', 'FAILED'])).toBe('COMPLETED');
    expect(runRow(stack.temp, second.id)).toMatchObject({ attempts: 1, failed_attempts: 0 });
    expect(eventCount(stack.temp, run.id, 'model.responded') + eventCount(stack.temp, second.id, 'model.responded')).toBe(stack.completions());
  });
});

describe('the start of a runtime beside other generations (20.35, 20.49)', () => {
  it('reaps only the markers of its own generation and removes only the call locks nobody holds', async () => {
    const stack = await startStack();
    await prepareGeneration(stack.temp, 2);
    const foreignMarker = path.join(scopedPaths(stack.temp, FIRST_GENERATION).markers.tools, 'a'.repeat(64));
    fs.writeFileSync(foreignMarker, '');
    const heldLock = path.join(stack.temp.paths.callLocks, 'held.lock');
    const staleLock = path.join(stack.temp.paths.callLocks, 'stale.lock');
    const held = await testKernelLock().claim(heldLock);
    if (held.kind !== 'claimed') throw new Error('the test could not claim its call lock');
    fs.writeFileSync(staleLock, '');
    const gatewaySocketPath = generationLayout(stack.temp.home, FIRST_GENERATION).sockets.gateway;

    try {
      const launched = await launchRuntime(stack.temp, { generation: 2, gatewaySocketPath });

      expect(fs.existsSync(foreignMarker)).toBe(true);
      expect(fs.existsSync(heldLock)).toBe(true);
      expect(fs.existsSync(staleLock)).toBe(false);
      expect(fs.statSync(scopedPaths(stack.temp, 2).jobs).mode & 0o777).toBe(0o700);
      expect(fs.existsSync(scopedPaths(stack.temp, 2).tmp.spawn)).toBe(true);
      expect(launched.handle.role()).toBe('serving');
    } finally {
      held.lock.dispose();
    }
  });
});
