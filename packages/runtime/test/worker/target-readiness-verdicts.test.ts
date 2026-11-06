import { describe, expect, it } from 'vitest';
import { TARGET_NOT_READY, agentReadiness, readinessText } from '@momonga/protocol';
import { GatewayRequestError } from '../../src/gateway-client.ts';
import { capabilitiesFor, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { textStep } from './scripts.ts';

const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];
const MAX_CLAIMS = 6;

const runToEnd = async (env: Env, runId: string): Promise<void> => {
  for (let claim = 0; claim < MAX_CLAIMS && !TERMINAL.includes(env.run(runId).status); claim += 1) await env.runOnce(env.worker());
};

const DESIGN_R3 = 'a notice at session start: "This model cannot call tools. MomongaCode will answer without reading or changing files."';

const DESIGN_R1_UNAVAILABLE = 'a precondition failure at `capabilities()`: the target refused definitely, for example a model that does not exist | `unavailable` (carries the gateway\'s reason)';

describe(`the session-start surface owns the no-tools notice (design R3: ${DESIGN_R3})`, () => {
  it('a tool-less run journals no no-tools notice of its own, so no surface shows the verdict twice', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(32_000, { toolCalling: 'none' }) });
    env.gateway.script.push(textStep('A plain answer.'));
    const run = env.enqueue('Explain the module');

    await runToEnd(env, run.id);

    expect(env.run(run.id).status).toBe('COMPLETED');
    const notices = env.ofType(run.id, 'notice').map((event) => event.message);
    expect(notices.filter((message) => message.includes('cannot call tools'))).toEqual([]);
  });
});

describe(`admission reads a definite refusal at capabilities() as unavailable (design R1: ${DESIGN_R1_UNAVAILABLE})`, () => {
  it('ends the run FAILED target_not_ready with the unavailable verdict message and remedy, and sends nothing', async () => {
    const reason = 'the target "local" is not ready: its endpoint answered 412 to the capability read';
    const env = await makeEnv();
    env.gateway.capabilitiesHook = async () => {
      throw new GatewayRequestError({ status: 412, type: 'invalid_request', code: 'precondition_failed', message: reason });
    };
    const run = env.enqueue('Work');

    await runToEnd(env, run.id);

    const verdict = agentReadiness({ unavailable: reason });
    expect(env.run(run.id).status).toBe('FAILED');
    expect(env.run(run.id).error).toEqual({ code: TARGET_NOT_READY, message: readinessText(verdict) });
    expect(env.gateway.streams).toHaveLength(0);
  });
});
