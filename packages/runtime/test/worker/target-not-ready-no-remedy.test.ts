import { describe, expect, it } from 'vitest';
import { TARGET_NOT_READY } from '@momonga/protocol';
import type { Capabilities, NeedsProbe } from '@momonga/protocol';
import { capabilitiesFor, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';

const UNAVAILABLE_MESSAGE = 'The server of gemma-3-4b does not list "gemma-3-4b". Remove the model, or check that the server serves it.';

const UNAVAILABLE = {
  toolCalling: { state: 'unavailable', status: 412, type: 'invalid_request', code: 'model_not_listed', message: UNAVAILABLE_MESSAGE, param: 'model' },
  source: 'unprobed',
} as unknown as Capabilities;

const NEEDS_PROBE: NeedsProbe = {
  state: 'needs_probe',
  message: 'the model "gemma-3-4b" sets toolCalling to auto, but no probe record exists',
  evidence: 'no probe record for gemma-3-4b',
  remedy: 'run `momonga gateway probe gemma-3-4b`',
};

const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];
const MAX_CLAIMS = 6;

const runToEnd = async (env: Env, runId: string): Promise<void> => {
  for (let claim = 0; claim < MAX_CLAIMS && !TERMINAL.includes(env.run(runId).status); claim += 1) await env.runOnce(env.worker());
};

describe('the message a run stores when its model is not ready (design-model-names 2.10, 1.8 A39)', () => {
  it('stores exactly the unavailable message of the listing, one line, with no remedy that names a command', async () => {
    const env = await makeEnv();
    env.gateway.capabilitiesByModel[env.session.model] = UNAVAILABLE;
    const run = env.enqueue('Work');

    await runToEnd(env, run.id);

    const failed = env.run(run.id);
    expect(failed.status).toBe('FAILED');
    expect(failed.error).toEqual({ code: TARGET_NOT_READY, message: UNAVAILABLE_MESSAGE });
    expect(failed.error?.message.split('\n')).toHaveLength(1);
    for (const command of ['/model', 'models add', 'models detect']) expect(failed.error?.message).not.toContain(command);
    expect(env.gateway.streams).toEqual([]);
  });

  it('stores the message and the remedy line of the probe for a model that needs a probe, as before', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(32_000, { toolCalling: NEEDS_PROBE }) });
    const run = env.enqueue('Work');

    await runToEnd(env, run.id);

    const failed = env.run(run.id);
    expect(failed.status).toBe('FAILED');
    expect(failed.error).toEqual({ code: TARGET_NOT_READY, message: `${NEEDS_PROBE.message}\n${NEEDS_PROBE.remedy}` });
    expect(env.gateway.streams).toEqual([]);
  });
});
