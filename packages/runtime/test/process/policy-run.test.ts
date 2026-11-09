import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { launchRuntime, startStack, waitForStatus } from './run-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const PROCESS_TIMEOUT = { timeout: REAL_PROCESS_TEST_TIMEOUT_MS };
const TOOL_INPUT = 'Use the Read tool';

describe('policyFor failures at run level (system timers, in-process gateway)', () => {
  it('a session tmp dir replaced by a symlink fails the run with config_error', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp);
    const session = await launched.createSession();
    const elsewhere = path.join(stack.temp.root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.mkdirSync(stack.temp.paths.tmp.sessions, { recursive: true });
    fs.symlinkSync(elsewhere, path.join(stack.temp.paths.tmp.sessions, session.id));
    const run = await launched.createRun(session.id, { input: TOOL_INPUT });
    expect(await waitForStatus(stack.temp, run.id, ['COMPLETED', 'FAILED', 'CANCELLED'])).toBe('FAILED');
    expect((await launched.http('GET', `/v1/runs/${run.id}`)).json.run.error).toMatchObject({ code: 'config_error' });
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('EACCES on the sessions root (mode 000) fails the run with config_error instead of requeueing it', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp);
    const session = await launched.createSession();
    fs.chmodSync(stack.temp.paths.tmp.sessions, 0o000);
    try {
      const run = await launched.createRun(session.id, { input: TOOL_INPUT });
      expect(await waitForStatus(stack.temp, run.id, ['COMPLETED', 'FAILED', 'CANCELLED'])).toBe('FAILED');
      const view = (await launched.http('GET', `/v1/runs/${run.id}`)).json.run;
      expect(view.error).toMatchObject({ code: 'config_error' });
      expect(stack.completions()).toBe(1);
    } finally {
      fs.chmodSync(stack.temp.paths.tmp.sessions, 0o700);
    }
  });
});
