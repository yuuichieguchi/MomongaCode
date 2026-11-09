import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { startGatewayProcess } from '@momonga/gateway';
import { PROCESS_VERSION, baseEnv, makeHome, writeSettings } from './gateway-process-helpers.ts';
import { FIRST_GENERATION } from '@momonga/foundation';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

describe('a plan target before the session engine exists', () => {
  it('stops the gateway start naming the target and the profile instead of serving it without a credential', async () => {
    const home = makeHome();
    writeSettings(home, {
      models: {
        aliases: { default: 'gpt' },
        targets: { gpt: { adapter: 'open-responses', model: 'gpt-fake', plan: { profile: 'chatgpt' } } },
      },
    });
    await expect(startGatewayProcess({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION })).rejects.toThrow(/target gpt uses plan profile chatgpt/);
  });
});
