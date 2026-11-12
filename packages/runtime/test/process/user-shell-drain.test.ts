import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock, createFakeTimers } from '@momonga/testkit';
import { START_MS } from './helpers.ts';
import { fireTimer, launchRuntime, startStack, waitForCondition, waitForTimer } from './run-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const DRAIN_MS = 60_000;

type ExitRecord = { command: string; exitCode: number | null; output: string };

const exitRecordOf = (text: string): ExitRecord => {
  const match = /event: exit\ndata: (.*)\n/.exec(text);
  if (match?.[1] === undefined) throw new Error(`the user command stream has no exit frame: ${text}`);
  const frame: unknown = JSON.parse(match[1]);
  if (typeof frame !== 'object' || frame === null || !('record' in frame)) throw new Error(`the exit frame has no record: ${match[1]}`);
  return frame.record as ExitRecord;
};

const launchedWithCommand = async () => {
  const stack = await startStack();
  const clock = createFakeClock(START_MS);
  const timers = createFakeTimers(clock);
  const launched = await launchRuntime(stack.temp, { clock, fakeTimers: timers, drainTimeoutMs: DRAIN_MS });
  const session = await launched.createSession();
  const started = path.join(stack.temp.project, 'started');
  const go = path.join(stack.temp.project, 'go');
  const command = `touch ${started}; while [ ! -f ${go} ]; do sleep 0.05; done; echo finished`;
  const response = launched.http('POST', `/v1/sessions/${session.id}/user-shell`, { body: { command, include: false } });
  await waitForCondition(() => fs.existsSync(started), 'the user command to start');
  return { launched, timers, response, go };
};

describe('a user command is work of its generation (DECISION-4)', () => {
  it('a close waits for a user command in flight under the drain bound, and the command ends by itself', async () => {
    const { launched, timers, response, go } = await launchedWithCommand();

    const closing = launched.handle.close();
    await waitForTimer(timers, DRAIN_MS, 'the drain timer');
    fs.writeFileSync(go, '');

    const record = exitRecordOf((await response).text);
    expect(record).toMatchObject({ exitCode: 0, output: 'finished' });
    expect(await closing).toEqual({ clean: true, abandoned: [], stragglers: [] });
  });

  it('a close aborts a user command still running when the drain bound ends', async () => {
    const { launched, timers, response } = await launchedWithCommand();

    const closing = launched.handle.close();
    await fireTimer(timers, DRAIN_MS, 'the drain timer');

    const record = exitRecordOf((await response).text);
    expect(record.exitCode).not.toBe(0);
    expect(record.output).not.toContain('finished');
    expect(await closing).toMatchObject({ clean: true });
  });
});
