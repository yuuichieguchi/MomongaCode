import { describe, expect, it } from 'vitest';
import { DAEMON_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { launchRuntime, prepareStack } from './run-helpers.ts';

describe('the runtime reads settings that declare a server (design-managed-servers 19.12, 19.14 item 4, reader R10; R-S19-24)', { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('starts and answers health with a target of a declared server in the user settings', async () => {
    const stack = await prepareStack();
    stack.settings({
      models: {
        servers: { loom: { command: '/opt/loom/bin/loom-server', args: ['run', '--socket', '{socket}'], readyPath: '/ready' } },
        targets: { workbench: { adapter: 'managed', server: 'loom', model: 'fake-1' } },
        aliases: { default: ['workbench'] },
      },
    });
    const launched = await launchRuntime(stack.temp);
    expect((await launched.http('GET', '/v1/health')).status).toBe(200);
  });
});
