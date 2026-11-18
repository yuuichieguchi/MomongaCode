import fs from 'node:fs';
import path from 'node:path';
import { withTempDir } from '@momonga/testkit';
import type { TestContext } from 'vitest';
import { describe, expect, it } from 'vitest';
import { GENERATION_POLL_INTERVAL_MS, STARTUP_TIMEOUT_MS, STDIO_FLUSH_MS } from '@momonga/foundation';
import { DEFAULT_RESTART_POLICY, childRestartBoundMs, resolveStartTiming, supervisorStartBoundMs } from '@momonga/supervisor';
import { daemonReadyBoundMs, startProgressMarkOf } from '../src/daemon/ensure-daemon.ts';
import type { SupervisorHealth } from '@momonga/protocol';

const crashRestartBoundMs = (startupTimeoutMs = STARTUP_TIMEOUT_MS): number => childRestartBoundMs({ policy: DEFAULT_RESTART_POLICY, startupTimeoutMs, stdioFlushMs: STDIO_FLUSH_MS });

const refuseNotice = (message: string): void => {
  throw new Error(`no notice was expected: ${message}`);
};

const homeWithSettings = (context: TestContext, settings: string | undefined): string => {
  const home = withTempDir(context, { asHome: true });
  if (settings !== undefined) {
    const file = path.join(home, '.momonga', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, settings);
  }
  return home;
};

const readyBoundIn = (context: TestContext, settings?: string, onNotice: (message: string) => void = refuseNotice): Promise<number> =>
  daemonReadyBoundMs({ home: homeWithSettings(context, settings), env: {} }, onNotice);

describe('the client ready bound', () => {
  it('is the larger of the first-start bound and the crash-restart bound', async (context) => {
    const firstStart = supervisorStartBoundMs(resolveStartTiming({}));
    expect(await readyBoundIn(context)).toBe(Math.max(firstStart, crashRestartBoundMs()));
  });

  it('is larger than the start-up stall limit of one child', async (context) => {
    expect(await readyBoundIn(context)).toBeGreaterThan(STARTUP_TIMEOUT_MS);
  });

  it('awaits a child that crashed with the longest backoff and started again within its start-up limit', async (context) => {
    const restartedAfterMs = DEFAULT_RESTART_POLICY.maxMs + STARTUP_TIMEOUT_MS;
    expect(await readyBoundIn(context)).toBeGreaterThanOrEqual(restartedAfterMs);
  });
});

describe('the client ready bound follows the start-up stall limit the supervisor reads from the settings', () => {
  const LARGE_STALL_MS = 600_000;

  it('with a larger daemon.startupStallMs, the client waits at least as long as the supervisor does for its first start and for a crash restart', async (context) => {
    const bound = await readyBoundIn(context, JSON.stringify({ daemon: { startupStallMs: LARGE_STALL_MS } }));
    expect(bound).toBe(Math.max(supervisorStartBoundMs(resolveStartTiming({ startupTimeoutMs: LARGE_STALL_MS })), crashRestartBoundMs(LARGE_STALL_MS)));
    expect(bound).toBeGreaterThanOrEqual(DEFAULT_RESTART_POLICY.maxMs + LARGE_STALL_MS);
  });

  it('with settings that cannot be read, uses the default limit the supervisor uses then and says so', async (context) => {
    const notices: string[] = [];
    const bound = await readyBoundIn(context, '{ not json', (message) => notices.push(message));
    expect(bound).toBe(Math.max(supervisorStartBoundMs(resolveStartTiming({})), crashRestartBoundMs()));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('the start-up stall limit could not be read from the user settings');
  });
});

describe('the first-start bound of the supervisor', () => {
  it('is the sum of its generation lock wait and its promotion wait', () => {
    const timing = resolveStartTiming({ startupTimeoutMs: 1000 });
    expect(supervisorStartBoundMs(timing)).toBe(1000 + GENERATION_POLL_INTERVAL_MS + 1000);
  });

  it('a start that promotes at the last moment of its bound is inside the client wait', async (context) => {
    expect(supervisorStartBoundMs(resolveStartTiming({}))).toBeLessThanOrEqual(await readyBoundIn(context));
  });
});

describe('the start progress the client sees', () => {
  const health = (children: SupervisorHealth['children']): SupervisorHealth => ({ status: 'ok', version: '1', pid: 1, startedAt: 't', phase: 'running', env: 'frozen at supervisor start', retention: null, children, logs: { droppedLines: 0 } });
  const runtime = (progressAt: string | undefined): SupervisorHealth['children'][number] => ({ role: 'runtime', state: 'starting', restarts: 0, consecutiveFailures: 0, ...(progressAt === undefined ? {} : { progressAt }) });

  it('changes when a child reports start-up progress and stays when nothing moves', () => {
    expect(startProgressMarkOf(health([runtime('a')]))).not.toBe(startProgressMarkOf(health([runtime('b')])));
    expect(startProgressMarkOf(health([runtime('a')]))).toBe(startProgressMarkOf(health([runtime('a')])));
    expect(startProgressMarkOf(undefined)).toBe(startProgressMarkOf(undefined));
    expect(startProgressMarkOf(undefined)).not.toBe(startProgressMarkOf(health([runtime(undefined)])));
  });
});
