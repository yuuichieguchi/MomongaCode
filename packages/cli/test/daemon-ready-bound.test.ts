import { describe, expect, it } from 'vitest';
import { GENERATION_POLL_INTERVAL_MS, STARTUP_TIMEOUT_MS, STDIO_FLUSH_MS } from '@momonga/foundation';
import { DEFAULT_RESTART_POLICY, childRestartBoundMs, resolveStartTiming, supervisorStartBoundMs } from '@momonga/supervisor';
import { daemonReadyBoundMs, startProgressMarkOf } from '../src/daemon/ensure-daemon.ts';
import type { SupervisorHealth } from '@momonga/protocol';

const crashRestartBoundMs = (): number => childRestartBoundMs({ policy: DEFAULT_RESTART_POLICY, startupTimeoutMs: STARTUP_TIMEOUT_MS, stdioFlushMs: STDIO_FLUSH_MS });

describe('the client ready bound', () => {
  it('is the larger of the first-start bound and the crash-restart bound', async () => {
    const firstStart = supervisorStartBoundMs(resolveStartTiming({}));
    expect(await daemonReadyBoundMs()).toBe(Math.max(firstStart, crashRestartBoundMs()));
  });

  it('is larger than the start-up stall limit of one child', async () => {
    expect(await daemonReadyBoundMs()).toBeGreaterThan(STARTUP_TIMEOUT_MS);
  });

  it('awaits a child that crashed with the longest backoff and started again within its start-up limit', async () => {
    const restartedAfterMs = DEFAULT_RESTART_POLICY.maxMs + STARTUP_TIMEOUT_MS;
    expect(await daemonReadyBoundMs()).toBeGreaterThanOrEqual(restartedAfterMs);
  });
});

describe('the first-start bound of the supervisor', () => {
  it('is the sum of its generation lock wait and its promotion wait', () => {
    const timing = resolveStartTiming({ startupTimeoutMs: 1000 });
    expect(supervisorStartBoundMs(timing)).toBe(1000 + GENERATION_POLL_INTERVAL_MS + 1000);
  });

  it('a start that promotes at the last moment of its bound is inside the client wait', async () => {
    expect(supervisorStartBoundMs(resolveStartTiming({}))).toBeLessThanOrEqual(await daemonReadyBoundMs());
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
