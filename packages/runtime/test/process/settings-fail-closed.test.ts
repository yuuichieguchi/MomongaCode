import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, DAEMON_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { writeInvalidUserSettings } from './helpers.ts';
import { launchRuntime, sessionEnvFor, startStack, waitForStatus } from './run-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const PROCESS_TIMEOUT = { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS };

describe('fail-closed user settings under a running runtime (system timers, in-process gateway)', () => {
  it('after the user settings file becomes invalid, session create answers 422 config_error', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp);
    writeInvalidUserSettings(stack.temp.home);
    const response = await launched.http('POST', '/v1/sessions', { body: { cwd: stack.temp.project, env: sessionEnvFor(stack.temp.home) } });
    expect(response.status).toBe(422);
    expect(response.json.error).toMatchObject({ code: 'config_error' });
  });

  it('after the user settings file becomes invalid, a new run is refused with config_error', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp);
    const session = await launched.createSession();
    writeInvalidUserSettings(stack.temp.home);
    const response = await launched.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'hello' } });
    expect(response.status).toBe(422);
    expect(response.json.error).toMatchObject({ code: 'config_error' });
  });

  it('after the user settings file becomes invalid, cancellation still reaches CANCELLED', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp);
    const hold = stack.hold();
    const session = await launched.createSession();
    const run = await launched.createRun(session.id);
    await hold.waitForRequest();
    writeInvalidUserSettings(stack.temp.home);
    expect((await launched.http('POST', `/v1/runs/${run.id}/cancel`)).status).toBeLessThan(300);
    hold.release();
    expect(await waitForStatus(stack.temp, run.id, ['COMPLETED', 'FAILED', 'CANCELLED'])).toBe('CANCELLED');
  });

  it('no credential names are guessed: a session create with env fails with 422', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp);
    writeInvalidUserSettings(stack.temp.home);
    const response = await launched.http('POST', '/v1/sessions', {
      body: { cwd: stack.temp.project, env: { ...sessionEnvFor(stack.temp.home), FM_UPSTREAM_VALUE: 'not-a-secret' } },
    });
    expect(response.status).toBe(422);
    expect(response.json.error).toMatchObject({ code: 'config_error' });
    expect((await launched.http('GET', '/v1/sessions')).json.sessions).toEqual([]);
  });

  it('fixing the file restores service without a restart', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp);
    writeInvalidUserSettings(stack.temp.home);
    expect((await launched.http('POST', '/v1/sessions', { body: { cwd: stack.temp.project, env: sessionEnvFor(stack.temp.home) } })).status).toBe(422);
    stack.settings();
    const session = await launched.createSession();
    const run = await launched.createRun(session.id);
    expect(await waitForStatus(stack.temp, run.id, ['COMPLETED', 'FAILED', 'CANCELLED'])).toBe('COMPLETED');
    expect(launched.stdout.lines()).toHaveLength(1);
  });

  it('health keeps reporting the startup sandbox kind', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp);
    writeInvalidUserSettings(stack.temp.home);
    const health = await launched.http('GET', '/v1/health');
    expect(health.status).toBe(200);
    expect(health.json).toMatchObject({ sandbox: 'none', state: 'running' });
  });
});
