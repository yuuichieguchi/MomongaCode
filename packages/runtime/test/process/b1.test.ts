import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, FAKE_DETERMINISTIC_REPLY } from '@momonga/testkit';
import { eventTypes, launchRuntime, readDb, startStack, waitForStatus } from './run-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const PROCESS_TIMEOUT = { timeout: REAL_PROCESS_TEST_TIMEOUT_MS };

describe('scenario b1: abort mid-request, then restart (system timers, in-process gateway)', () => {
  it('a run aborted while its model request is in flight completes after a restart with a single upstream request', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const first = await launchRuntime(stack.temp);
    const session = await first.createSession();
    const hold = stack.hold();
    const run = await first.createRun(session.id);
    await hold.waitForRequest();
    expect(await first.handle.abort()).toEqual({ clean: true, abandoned: [], stragglers: [] });
    expect(await waitForStatus(stack.temp, run.id, ['QUEUED', 'COMPLETED', 'FAILED'])).toBe('QUEUED');
    hold.release();

    const second = await launchRuntime(stack.temp);
    const stream = await second.stream(`/v1/runs/${run.id}/events`);
    const frames = await stream.toEnd(30_000);
    expect(frames.at(-1)).toMatchObject({ type: 'run.status', to: 'COMPLETED' });
    expect(frames.filter((event) => event.type === 'agent.message.delta').map((event) => event.text).join('')).toBe(FAKE_DETERMINISTIC_REPLY);
    expect(stack.completions()).toBe(1);
    expect(readDb<{ step: number }>(stack.temp.paths.databases.runtime, 'SELECT step FROM runs WHERE id = ?', run.id)[0]?.step).toBe(1);
    expect(eventTypes(stack.temp, run.id).filter((type) => type === 'model.responded')).toHaveLength(1);
  });
});
