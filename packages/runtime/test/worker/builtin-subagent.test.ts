import { describe, expect, it, vi } from 'vitest';
import { GENERAL_PURPOSE_AGENT } from '@momonga/agents';
import { createNodeSkillFileSystem } from '@momonga/skills';
import { createAgentsPort, createChildRuns } from '@momonga/runtime';
import type { AgentsPort } from '@momonga/runtime';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { makeEnv, textOf } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';
import { fakeViewsOf } from './fake-gateway.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const agentsPortOf = (env: Env): AgentsPort =>
  createAgentsPort({
    home: env.home,
    fileSystem: createNodeSkillFileSystem(),
    settings: { trusted: async () => env.settings.trustedValue, approvedProjectAgents: async () => ({ has: () => true }) },
    runs: createChildRuns({ store: env.store, modelViews: async () => fakeViewsOf(['fm']) }),
  });

const offered = (env: Env, index: number) => (env.gateway.streams[index]?.body.tools ?? []).flatMap((tool) => (tool.type === 'function' ? [tool] : []));

const instructionsOf = (env: Env, index: number): string => {
  const input = env.gateway.streams[index]?.body.input;
  const messages = (Array.isArray(input) ? input : []).filter((item) => item.type === 'message' && (item.role === 'developer' || item.role === 'system')).map(textOf);
  return [env.gateway.streams[index]?.body.instructions ?? '', ...messages].join('\n');
};

describe('the built-in subagent in a session with no agent definition', () => {
  it('offers the Agent tool for general-purpose and runs it as a child with every tool of the parent but Agent', async () => {
    const env = await makeEnv();
    const worker = env.worker('w1', { agents: agentsPortOf(env) });
    const parent = await env.enqueue('Find where the parser lives');
    env.gateway.script.push(
      callsStep([{ callId: 'call-gp', name: 'Agent', args: { description: 'find the parser', prompt: 'Find the parser', subagent_type: 'general-purpose' } }]),
      textStep('the parser is in src/parse.ts'),
      textStep('done'),
    );

    await env.runOnce(worker);
    const agentTool = offered(env, 0).find((tool) => tool.name === 'Agent');
    expect(agentTool?.parameters).toMatchObject({ properties: { subagent_type: { enum: ['general-purpose'] } } });
    const [child] = env.store.listChildRuns(parent.id);
    if (child === undefined) throw new Error('the parent did not create a child run');

    await env.runOnce(worker);
    expect(env.run(child.id).status).toBe('COMPLETED');
    const parentNames = offered(env, 0).map((tool) => tool.name);
    expect(offered(env, 1).map((tool) => tool.name)).toEqual(parentNames.filter((name) => name !== 'Agent'));
    expect(instructionsOf(env, 1)).toContain('subagent "general-purpose"');
    expect(instructionsOf(env, 1)).toContain(GENERAL_PURPOSE_AGENT.prompt);

    await env.runOnce(worker);
    expect(env.run(parent.id).status).toBe('COMPLETED');
    expect(env.ofType(parent.id, 'tool.completed')).toMatchObject([{ status: 'completed', output: 'the parser is in src/parse.ts' }]);
  });
});
