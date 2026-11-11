import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { FIRST_GENERATION, createFileCredentialStore, momongaLayout, nodeFileSystem } from '@momonga/foundation';
import { PLAN_ROUTES } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeSecretStore, startFakeSiwcAuth, testKernelLock } from '@momonga/testkit';
import { ensureHostIdentity } from '../src/plan/host-identity.ts';
import { getJson, registerCleanup } from './gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, clientFor, launchGateway, makeHome, writeSettings, modelsOf } from './gateway-process-helpers.ts';
import { ACCOUNT } from './plan-signin-support.ts';
import { PROFILE_ID, profileFor } from './plan-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const FAR_EXPIRY_MS = 4_102_444_800_000;

describe('O-R5-6 L1: the plan scope D5 is derived before the start loads an account', () => {
  it('a plaintext record pinned at start is read with the flag of the settings', async () => {
    const home = makeHome();
    const layout = momongaLayout(home);
    fs.mkdirSync(layout.planSessions, { recursive: true, mode: 0o700 });
    const { hostId } = await ensureHostIdentity(nodeFileSystem, layout.planHost, { lock: testKernelLock(), accountsExist: false });
    await createFileCredentialStore(layout.planSessions, { lock: testKernelLock() }).write(
      `plan/${PROFILE_ID}/${ACCOUNT}`,
      JSON.stringify({
        version: 1,
        profile: PROFILE_ID,
        account: ACCOUNT,
        state: 'active',
        client_id: `client-of-${ACCOUNT}`,
        ext_agent_host_id: hostId,
        welcomeShown: true,
        subject: `subject-of-${ACCOUNT}`,
        email: `${ACCOUNT}@example.test`,
        access_token: `access-of-${ACCOUNT}`,
        refresh_token: `refresh-of-${ACCOUNT}`,
        expiresAt: FAR_EXPIRY_MS,
      }), new AbortController().signal,
    );
    writeSettings(home, {
      credentials: { plaintextTokenFiles: true },
      models: modelsOf({ gpt: { adapter: 'open-responses', model: 'plan-model', capabilities: { contextWindow: 128000, maxOutputTokens: 16000 }, plan: { profile: PROFILE_ID, account: ACCOUNT } } }),
    });
    const auth = await startFakeSiwcAuth({});
    registerCleanup(() => auth.close());
    const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, secretStore: createFakeSecretStore({}), planProfiles: { [PROFILE_ID]: profileFor(auth) } });
    const listed = await getJson(clientFor(handle.socketPath), `/v1/momonga/plan${PLAN_ROUTES.accounts}`);
    expect(listed.status).toBe(200);
    expect((listed.body.accounts as { label: string; state: string }[]).find((entry) => entry.label === ACCOUNT)).toMatchObject({ state: 'active' });
  });
});
