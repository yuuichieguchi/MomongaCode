import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { FIRST_GENERATION, createFileCredentialStore, momongaLayout } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeSecretStore } from '@momonga/testkit';
import { getJson } from './gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, clientFor, launchGateway, makeHome, writeSettings, modelsOf } from './gateway-process-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const planSettings = (account?: string) => ({
  models: modelsOf({
      gpt: { adapter: 'open-responses', model: 'gpt-fake', capabilities: { contextWindow: 128000, maxOutputTokens: 16000 }, plan: { profile: 'chatgpt', ...(account === undefined ? {} : { account }) } },
    }),
});

const targetHealth = async (home: string) => {
  const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, secretStore: createFakeSecretStore({}) });
  const health = await getJson(clientFor(handle.socketPath), '/v1/momonga/health');
  expect(health.status).toBe(200);
  return health.body.models['gpt/gpt-fake'];
};

describe('the gateway serves a plan target through the session engine (P5a-w)', () => {
  it('starts with a plan target and reports it sign_in_required while no account is signed in', async () => {
    const home = makeHome();
    writeSettings(home, planSettings());
    expect(await targetHealth(home)).toMatchObject({ ok: false, reason: 'sign_in_required' });
  });

  it('reads account records through the encrypted store of N81, so a plaintext record is store_unreadable, never needs_sign_in', async () => {
    const home = makeHome();
    writeSettings(home, planSettings('work'));
    const sessions = momongaLayout(home).planSessions;
    fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
    await createFileCredentialStore(sessions).write('plan/chatgpt/work', JSON.stringify({ version: 1, profile: 'chatgpt', account: 'work', state: 'registered' }), new AbortController().signal);
    const health = await targetHealth(home);
    expect(health).toMatchObject({ ok: false, reason: 'store_unreadable' });
    expect(health.detail).toContain('is not encrypted');
  });
});
