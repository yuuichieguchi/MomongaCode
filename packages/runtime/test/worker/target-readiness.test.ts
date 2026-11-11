import { describe, expect, it } from 'vitest';
import { TARGET_NOT_READY, agentReadiness } from '@momonga/protocol';
import type { NeedsProbe } from '@momonga/protocol';
import { capabilitiesFor, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { textStep } from './scripts.ts';

const NEEDS_PROBE: NeedsProbe = {
  state: 'needs_probe',
  message: 'target local has not been probed for tool calling',
  evidence: 'no probe record for local',
  remedy: 'run the tool-calling probe for local',
};

const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];
const MAX_CLAIMS = 6;

const runToEnd = async (env: Env, runId: string): Promise<void> => {
  for (let claim = 0; claim < MAX_CLAIMS && !TERMINAL.includes(env.run(runId).status); claim += 1) await env.runOnce(env.worker());
};

describe('run admission decides readiness with agentReadiness before any model request', () => {
  it('ends a run on an unprobed target FAILED target_not_ready with the probe remedy and sends nothing', async () => {
    const capabilities = capabilitiesFor(32_000, { toolCalling: NEEDS_PROBE });
    const env = await makeEnv({ capabilities });
    const run = await env.enqueue('Work');

    await runToEnd(env, run.id);

    const final = env.run(run.id);
    expect(final.status).toBe('FAILED');
    expect(final.error).toEqual({ code: TARGET_NOT_READY, message: expect.stringContaining(NEEDS_PROBE.remedy) });
    expect(env.gateway.streams).toHaveLength(0);
  });

  it('records at admission the same verdict that session open shows for the same capabilities', async () => {
    const capabilities = capabilitiesFor(32_000, { toolCalling: NEEDS_PROBE });
    const shown = agentReadiness(capabilities);
    const env = await makeEnv({ capabilities });
    const run = await env.enqueue('Work');

    await runToEnd(env, run.id);

    if (shown.state !== 'needs_probe') throw new Error(`session open showed ${shown.state}`);
    expect(env.run(run.id).error?.message).toContain(shown.message);
  });

  it('runs a target that reports no tool calling without tools on the wire and completes', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(32_000, { toolCalling: 'none' }) });
    env.gateway.script.push(textStep('A plain answer.'));
    const run = await env.enqueue('Explain the module');

    await runToEnd(env, run.id);

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.streams).toHaveLength(1);
    const body = env.gateway.streams[0]?.body;
    expect(body?.tools ?? []).toEqual([]);
    expect([undefined, 'none']).toContain(body?.tool_choice);
  });

  it.each(['native', 'constrained'] as const)('still offers tools to a %s target', async (toolCalling) => {
    const env = await makeEnv({ capabilities: capabilitiesFor(32_000, { toolCalling }) });
    env.gateway.script.push(textStep('Done.'));
    const run = await env.enqueue('Work');

    await runToEnd(env, run.id);

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect((env.gateway.streams[0]?.body.tools ?? []).length).toBeGreaterThan(0);
  });
});
