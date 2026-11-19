import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createNodeSkillFileSystem } from '@momonga/skills';
import { createAgentsPort, createChildRuns } from '@momonga/runtime';
import type { AgentsPort } from '@momonga/runtime';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { capabilitiesFor, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';
import { fakeViewsOf } from './fake-gateway.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const MAIN = 'fm';
const OTHER = 'fm-large';
const REASONING = { control: 'reasoning_effort', lowest: 'low' } as const;

const agentsPortOf = (env: Env): AgentsPort =>
  createAgentsPort({
    home: env.home,
    fileSystem: createNodeSkillFileSystem(),
    settings: { trusted: async () => env.settings.trustedValue, approvedProjectAgents: async () => ({ has: () => true }) },
    runs: createChildRuns({ store: env.store, listing: async () => ({ models: [], views: fakeViewsOf([MAIN, OTHER]) }) }),
  });

const writeAgent = (env: Env, name: string, frontmatter: string): void => {
  const directory = path.join(env.project, '.momonga', 'agents');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${name}.md`), `---\nname: ${name}\ndescription: ${name} agent\n${frontmatter}---\nYou review code.\n`);
};

const childEffortOf = async (frontmatter: string): Promise<unknown> => {
  const env = await makeEnv({ capabilities: capabilitiesFor(8000, { reasoning: REASONING }) });
  env.gateway.capabilitiesByModel[OTHER] = capabilitiesFor(8000, { reasoning: REASONING });
  env.gateway.effortsByModel[OTHER] = 'low';
  env.store.setEffort(env.session.id, 'xhigh');
  writeAgent(env, 'reviewer', frontmatter);
  const worker = env.worker('w1', { agents: agentsPortOf(env) });
  await env.enqueue('Review my change');
  env.gateway.script.push(callsStep([{ callId: 'call-a', name: 'Agent', args: { description: 'review', prompt: 'Look', subagent_type: 'reviewer' } }]), textStep('child done'), textStep('parent done'));
  await env.runOnce(worker);
  await env.runOnce(worker);
  return env.gateway.streams[1]?.body.reasoning;
};

describe('the effort a subagent request is sent with', () => {
  it('is the level the parent run sends when the child runs on the parent model', async () => {
    expect(await childEffortOf('')).toEqual({ effort: 'xhigh' });
  });

  it('is the level of the child model, not the parent run level, when the child runs on another model', async () => {
    expect(await childEffortOf(`model: ${OTHER}\n`)).toEqual({ effort: 'low' });
  });
});
