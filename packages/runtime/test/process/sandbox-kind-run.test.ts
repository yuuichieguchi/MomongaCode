import { describe, expect, it } from 'vitest';
import { DAEMON_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { launchRuntime, startStack, waitForStatus } from './run-helpers.ts';

const PROCESS_TIMEOUT = { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS };

describe('sandbox kind through startRuntimeProcess (system timers, in-process gateway)', () => {
  it('health reports none under sandbox none, and Bash asks even in bypassPermissions', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp);
    expect(launched.handle.sandbox).toBe('none');
    const health = await launched.http('GET', '/v1/health');
    expect(health.json).toMatchObject({ status: 'ok', sandbox: 'none', state: 'running' });
    const session = await launched.createSession({ permissionMode: 'bypassPermissions', bypassAllowed: true });
    const run = await launched.createRun(session.id, { input: 'Use the Bash tool' });
    expect(await waitForStatus(stack.temp, run.id, ['WAITING_HUMAN', 'COMPLETED', 'FAILED'])).toBe('WAITING_HUMAN');
    const approvals = (await launched.http('GET', `/v1/runs/${run.id}/approvals`)).json.approvals;
    expect(approvals).toHaveLength(1);
  });

  it.runIf(process.platform === 'darwin')('a sandbox change applies in place: the Health value shows the kind the next batch takes, with no restart', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp);
    expect((await launched.http('GET', '/v1/health')).json).toMatchObject({ sandbox: 'none' });
    stack.settings({ sandbox: 'seatbelt' });
    const session = await launched.createSession();
    expect(session.id).toEqual(expect.any(String));
    expect((await launched.http('GET', '/v1/health')).json).toMatchObject({ status: 'ok', sandbox: 'seatbelt', state: 'running' });
  });
});
