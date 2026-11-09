import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, DAEMON_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { writeInvalidUserSettings } from './helpers.ts';
import { launchRuntime, startStack, waitForStatus } from './run-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const PROCESS_TIMEOUT = { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS };
const FINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];

describe('a broken user settings file under a running runtime (SettingsHealth, system timers, in-process gateway)', () => {
  it('NoRunFails: a Run admitted before the file broke completes on the last good copy', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp);
    const hold = stack.hold();
    const session = await launched.createSession();
    const run = await launched.createRun(session.id);
    await hold.waitForRequest();

    writeInvalidUserSettings(stack.temp.home);
    hold.release();

    expect(await waitForStatus(stack.temp, run.id, FINAL)).toBe('COMPLETED');
  });

  it('AdmittedOnlyWhenValid, RefusalNamesFile: a new Run in an existing session is refused with config_error naming the file', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp);
    const session = await launched.createSession();

    writeInvalidUserSettings(stack.temp.home);

    const response = await launched.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'hello' } });
    expect(response.status).toBe(422);
    expect(response.json.error).toMatchObject({ code: 'config_error' });
    expect(response.json.error.message).toContain(path.join(stack.temp.home, '.momonga', 'settings.json'));
    expect(response.json.error.message).toContain('running runs continue');
    expect((await launched.http('GET', `/v1/sessions/${session.id}/runs`)).json.runs).toEqual([]);
  });

  it('FixedThenAdmitted: once the file is valid again, a new Run in the same session is admitted and completes', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp);
    const session = await launched.createSession();
    writeInvalidUserSettings(stack.temp.home);
    expect((await launched.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'hello' } })).status).toBe(422);

    stack.settings();

    const run = await launched.createRun(session.id);
    expect(await waitForStatus(stack.temp, run.id, FINAL)).toBe('COMPLETED');
  });
});
