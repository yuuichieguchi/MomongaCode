import { describe, expect, it, vi } from 'vitest';
import { FIRST_GENERATION } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, openResponsesTextReply, startFakeOpenResponses } from '@momonga/testkit';
import { getJson, registerCleanup, listedMembersOf } from './gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, clientFor, launchGateway, makeHome, writeSettings, modelsOf } from './gateway-process-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const KEY_VARIABLE = 'MOMONGA_TARGET_KEY_TEST';
const CAPABILITIES = { contextWindow: 128000, maxOutputTokens: 16000 };

describe('the models listing names the key group of every API-key target, never the variable (O-R5-4 S6)', () => {
  it('reports key { group: server name } for a model that sends a key and nothing for a model without one', async () => {
    const fake = await startFakeOpenResponses({ script: [openResponsesTextReply(['unused'])] });
    registerCleanup(() => fake.close());
    const home = makeHome();
    writeSettings(home, {
      models: modelsOf({
          keyed: { adapter: 'open-responses', provider: 'acme', model: 'm', socketPath: fake.socketPath, apiKeyEnv: KEY_VARIABLE, capabilities: CAPABILITIES },
          open: { adapter: 'open-responses', provider: 'local-lab', model: 'm', socketPath: fake.socketPath, capabilities: CAPABILITIES },
        }, { fallbackTo: ['open'] }),
    });
    const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home, { [KEY_VARIABLE]: 'key-value-for-test' }), version: PROCESS_VERSION });
    const listed = await getJson(clientFor(handle.socketPath), '/v1/momonga/models');
    const members = listedMembersOf(listed.body, 'acme/m');
    expect(Object.fromEntries(Object.entries(members).map(([model, member]) => [model, member.key]))).toEqual({ 'acme/m': { group: 'acme' }, 'local-lab/m': undefined });
    expect(JSON.stringify(listed.body)).not.toContain(KEY_VARIABLE);
    await handle.close();
  });
});
