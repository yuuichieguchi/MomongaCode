import { afterEach, describe, expect, it } from 'vitest';
import { endpointKeyOf, probeEndpointTarget } from '@momonga/gateway';
import { startFakeChatCompletions, testKernelLock } from '@momonga/testkit';
import type { FakeChatCompletionsServer } from '@momonga/testkit';
import { makeDir } from './gateway-helpers.ts';
import { hostProbePorts } from './probe-ports-support.ts';

const servers: FakeChatCompletionsServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('the step bound given to a probe of an endpoint', () => {
  it('bounds every request step of the measurement', async () => {
    const fake = await startFakeChatCompletions({ scenario: 'tools-ok', modelId: 'qwen-fake', models: [{ id: 'qwen-fake', object: 'model' }], latencyMs: 800 });
    servers.push(fake);
    const upstream = { kind: 'unix', socketPath: fake.socketPath } as const;

    const failure = await probeEndpointTarget({
      ports: hostProbePorts,
      lock: testKernelLock(),
      probeRecordDir: makeDir(),
      upstream,
      key: { endpoint: endpointKeyOf(upstream), model: 'qwen-fake' },
      model: 'qwen-fake',
      apiKey: undefined,
      samples: 1,
      stepTimeoutMs: 100,
    }).catch((error: unknown) => error);

    expect(String(failure)).toMatch(/timed out after 100 ms/);
  });
});
