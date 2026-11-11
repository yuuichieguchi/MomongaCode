import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createUdsClient, credentialFileFor, fixedSocket } from '@momonga/foundation';
import { PLAN_ROUTES } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock } from '@momonga/testkit';
import { ACCOUNT, accountRoute, sessionsDirectory, signIn, startPlanGateway } from './plan-signin-support.ts';
import { writeSettings, modelsOf } from './gateway-process-helpers.ts';
import { CONDITION_WAIT, PROFILE_ID } from './plan-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const LISTED = [{ slug: 'plan-model', display_name: 'Plan Model', visibility: 'list', context_window: 200000 }];

describe('O-R5-6 L1: the close order keeps a refresh in flight to its end', () => {
  it('a refresh in flight at close finishes before the dispatcher closes', async () => {
    const clock = createFakeClock(Date.now());
    const gateway = await startPlanGateway({ clock, models: LISTED, plaintextTokenFiles: true });
    await signIn(gateway);
    const file = credentialFileFor(sessionsDirectory(gateway.home), `plan/${PROFILE_ID}/${ACCOUNT}`);
    const before = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    let reach = (): void => undefined;
    let release = (): void => undefined;
    const reached = new Promise<void>((resolve) => {
      reach = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    gateway.auth.scriptToken('refresh_token', [{ kind: 'hold', reached: reach, released }]);
    clock.advance(86_400_000);
    void gateway.get(`${accountRoute(PLAN_ROUTES.accountModels)}?profile=${PROFILE_ID}&refresh=1`).catch(() => undefined);
    await reached;
    writeSettings(gateway.home, {
      credentials: { plaintextTokenFiles: true },
      gateway: { closeGraceMs: 0, managedServerStopGraceMs: 0 },
      models: modelsOf({ gpt: { adapter: 'open-responses', model: 'plan-model', capabilities: { contextWindow: 128000, maxOutputTokens: 16000 }, plan: { profile: PROFILE_ID, account: ACCOUNT } } }),
    });
    const closing = gateway.close();
    await vi.waitFor(async () => {
      const probe = createUdsClient(fixedSocket(gateway.socketPath), { connectTimeoutMs: 0 });
      try {
        await expect(probe.request({ method: 'GET', path: '/v1/momonga/models' }).then((response) => response.text())).rejects.toThrow();
      } finally {
        probe.destroy();
      }
    }, CONDITION_WAIT);
    release();
    await closing;
    const after = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(gateway.auth.calls.tokenRefreshToken).toBe(1);
    expect(after).not.toHaveProperty('pendingRefresh');
    expect(after['access_token']).not.toBe(before['access_token']);
    expect(after['refresh_token']).not.toBe(before['refresh_token']);
    expect(gateway.auth.issuedSecrets()).toContain(after['access_token']);
  });
});
