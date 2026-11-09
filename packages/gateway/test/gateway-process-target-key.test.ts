import { describe, expect, it } from 'vitest';
import { FIRST_GENERATION } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, openResponsesTextReply, startFakeOpenResponses } from '@momonga/testkit';
import { getJson, registerCleanup } from './gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, clientFor, launchGateway, makeHome, writeSettings } from './gateway-process-helpers.ts';

const KEY_VARIABLE = 'MOMONGA_TARGET_KEY_TEST';
const CAPABILITIES = { contextWindow: 128000, maxOutputTokens: 16000 };

describe('the models listing names the key group of every API-key target, never the variable (O-R5-4 S6)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('reports targetKey { group: provider } for key targets and nothing for a target without a key', async () => {
    const fake = await startFakeOpenResponses({ script: [openResponsesTextReply(['unused'])] });
    registerCleanup(() => fake.close());
    const home = makeHome();
    writeSettings(home, {
      models: {
        aliases: { default: ['keyed', 'open'] },
        targets: {
          keyed: { adapter: 'open-responses', provider: 'acme', model: 'm', socketPath: fake.socketPath, apiKeyEnv: KEY_VARIABLE, capabilities: CAPABILITIES },
          open: { adapter: 'open-responses', provider: 'local-lab', model: 'm', socketPath: fake.socketPath, capabilities: CAPABILITIES },
        },
      },
    });
    const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home, { [KEY_VARIABLE]: 'key-value-for-test' }), version: PROCESS_VERSION });
    const listed = await getJson(clientFor(handle.socketPath), '/v1/momonga/models');
    const entry = listed.body.data.find((model: { id: string }) => model.id === 'default');
    expect(entry.targetKey).toEqual({ keyed: { group: 'acme' } });
    expect(JSON.stringify(listed.body)).not.toContain(KEY_VARIABLE);
    await handle.close();
  });
});
