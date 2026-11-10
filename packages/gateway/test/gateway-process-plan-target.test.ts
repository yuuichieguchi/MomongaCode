import { describe, expect, it, vi } from 'vitest';
import { FIRST_GENERATION } from '@momonga/foundation';
import { startGatewayProcess } from '@momonga/gateway';
import { REAL_PROCESS_TEST_TIMEOUT_MS, openResponsesTextReply, startFakeOpenResponses } from '@momonga/testkit';
import { postJson, registerCleanup, userInput } from './gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, clientFor, makeHome, writeSettings } from './gateway-process-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const PLAN_TEXT = 'target gpt uses plan profile chatgpt, which this gateway does not serve yet';

describe('a plan target the gateway cannot serve yet (design-settings-live 15.3)', () => {
  it('the gateway starts; a call routed to the plan target fails with the unserved text and another target serves', async () => {
    const local = await startFakeOpenResponses({ script: [openResponsesTextReply(['served'])] });
    registerCleanup(() => local.close());
    const home = makeHome();
    writeSettings(home, {
      models: {
        aliases: { default: 'gpt', local: 'local' },
        targets: {
          gpt: { adapter: 'open-responses', model: 'gpt-fake', plan: { profile: 'chatgpt' } },
          local: { adapter: 'open-responses', provider: 'fake', model: 'local-fake', socketPath: local.socketPath, capabilities: { contextWindow: 4096, maxOutputTokens: 512 } },
        },
      },
    });
    const handle = await startGatewayProcess({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, stdout: { write: () => true } });
    registerCleanup(async () => {
      await handle.close({ closeGraceMs: 0, managedServerStopGraceMs: 0 });
    });
    const client = clientFor(handle.socketPath);
    const refused = await postJson(client, '/v1/responses', { model: 'default', input: userInput('hi') });
    expect(await refused.text()).toContain(PLAN_TEXT);
    const served = await postJson(client, '/v1/responses', { model: 'local', input: userInput('hi') });
    expect(served.status).toBe(200);
    await served.text();
  });
});
