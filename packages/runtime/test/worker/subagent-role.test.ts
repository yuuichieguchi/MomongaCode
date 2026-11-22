import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNodeSkillFileSystem } from '@momonga/skills';
import { createAgentsPort, createChildRuns } from '@momonga/runtime';
import type { AgentsPort } from '@momonga/runtime';
import { createdRun, DEADLINE_MS, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';
import { fakeViewsOf } from './fake-gateway.ts';

const PARENT_MODEL = 'anthropic/opus-5.5';
const SUBAGENT_MODEL = 'google/gemini-neon';
const EXPLICIT_MODEL = 'anthropic/sonnet-5.5';
const ALL_MODELS = [PARENT_MODEL, SUBAGENT_MODEL, EXPLICIT_MODEL] as const;

const writeAgent = (env: Env, name: string, frontmatterExtra = ''): void => {
  const directory = path.join(env.project, '.momonga', 'agents');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${name}.md`), `---\nname: ${name}\ndescription: ${name} agent\n${frontmatterExtra}---\nYou do the work.\n`);
};

const agentsPortOf = (env: Env): AgentsPort =>
  createAgentsPort({
    home: env.home,
    fileSystem: createNodeSkillFileSystem(),
    settings: { trusted: async () => env.settings.trustedValue, approvedProjectAgents: async () => ({ has: () => true }) },
    runs: createChildRuns({ store: env.store, listing: async () => ({ models: [], views: fakeViewsOf([...ALL_MODELS]) }) }),
  });

const setup = async (roles: Record<string, string>, effort?: 'high') => {
  const env = await makeEnv();
  env.gateway.listed = [...ALL_MODELS];
  env.gateway.roles = { ...roles };
  env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
  const session = env.store.createSession({
    cwd: env.project,
    env: { PATH: '/usr/bin:/bin', LANG: 'C' },
    permissionMode: 'manual',
    model: PARENT_MODEL,
    ...(effort === undefined ? {} : { effort }),
  });
  const enqueue = async (input: string) =>
    createdRun(await env.store.createRunAndEnqueue(session.id, { input, timeoutMs: DEADLINE_MS - env.clock.now(), limits: {}, pins: {}, history: 'fresh' }));
  return { env, enqueue };
};

describe('models.roles.subagent', () => {
  it('routes built-in general-purpose and model-less agents to models.roles.subagent (including across providers) and does not inherit parent effort on a different model', async () => {
    const { env, enqueue } = await setup({ subagent: SUBAGENT_MODEL }, 'high');
    writeAgent(env, 'worker');
    const worker = env.worker('w1', { agents: agentsPortOf(env) });
    env.gateway.script.push(
      callsStep([
        { callId: 'call-gp', name: 'Agent', args: { description: 'gp', prompt: 'Do gp', subagent_type: 'general-purpose' } },
        { callId: 'call-w', name: 'Agent', args: { description: 'w', prompt: 'Do w', subagent_type: 'worker' } },
      ]),
    );
    const parent = await enqueue('Delegate');
    await env.runOnce(worker);

    const children = env.store.listChildRuns(parent.id);
    expect(children).toHaveLength(2);
    for (const child of children) {
      const session = env.store.getSession(child.sessionId);
      expect(session?.model).toBe(SUBAGENT_MODEL);
      expect(session?.effort).toBeNull();
    }
  });

  it('keeps the parent model and effort when models.roles.subagent is not set', async () => {
    const { env, enqueue } = await setup({}, 'high');
    const worker = env.worker('w1', { agents: agentsPortOf(env) });
    env.gateway.script.push(callsStep([{ callId: 'call-gp', name: 'Agent', args: { description: 'gp', prompt: 'Do gp', subagent_type: 'general-purpose' } }]));
    const parent = await enqueue('Delegate');
    await env.runOnce(worker);

    const [child] = env.store.listChildRuns(parent.id);
    const session = child === undefined ? undefined : env.store.getSession(child.sessionId);
    expect(session?.model).toBe(PARENT_MODEL);
    expect(session?.effort).toBe('high');
  });

  it('inherits parent effort when models.roles.subagent matches the parent model', async () => {
    const { env, enqueue } = await setup({ subagent: PARENT_MODEL }, 'high');
    const worker = env.worker('w1', { agents: agentsPortOf(env) });
    env.gateway.script.push(callsStep([{ callId: 'call-gp', name: 'Agent', args: { description: 'gp', prompt: 'Do gp', subagent_type: 'general-purpose' } }]));
    const parent = await enqueue('Delegate');
    await env.runOnce(worker);

    const [child] = env.store.listChildRuns(parent.id);
    const session = child === undefined ? undefined : env.store.getSession(child.sessionId);
    expect(session?.model).toBe(PARENT_MODEL);
    expect(session?.effort).toBe('high');
  });

  it('lets an agent file win over models.roles.subagent for both an explicit model and model: inherit', async () => {
    const { env, enqueue } = await setup({ subagent: SUBAGENT_MODEL }, 'high');
    writeAgent(env, 'coder', `model: ${EXPLICIT_MODEL}\n`);
    writeAgent(env, 'planner', 'model: inherit\n');
    const worker = env.worker('w1', { agents: agentsPortOf(env) });
    env.gateway.script.push(
      callsStep([
        { callId: 'call-coder', name: 'Agent', args: { description: 'code', prompt: 'Code it', subagent_type: 'coder' } },
        { callId: 'call-planner', name: 'Agent', args: { description: 'plan', prompt: 'Plan it', subagent_type: 'planner' } },
      ]),
    );
    const parent = await enqueue('Delegate');
    await env.runOnce(worker);

    const children = env.store.listChildRuns(parent.id);
    expect(children).toHaveLength(2);
    const byCall = new Map(children.map((child) => [child.parentCallId, env.store.getSession(child.sessionId)]));
    expect(byCall.get(env.gateway.callId('call-coder'))?.model).toBe(EXPLICIT_MODEL);
    expect(byCall.get(env.gateway.callId('call-coder'))?.effort).toBeNull();
    expect(byCall.get(env.gateway.callId('call-planner'))?.model).toBe(PARENT_MODEL);
    expect(byCall.get(env.gateway.callId('call-planner'))?.effort).toBe('high');
  });

  it('fails a child run whose pinned models.roles.subagent no longer names a configured model', async () => {
    const { env, enqueue } = await setup({});
    const parent = await enqueue('Parent');
    const claim = await env.seed(parent.id, [{ type: 'run.started', attempt: 1, now: env.clock.now(), pins: { model: PARENT_MODEL, roles: { subagent: 'removed/model' } }, mode: 'manual' }], 'hold');
    const created = await env.store.createChildRun({ parentRunId: parent.id, parentCallId: 'call_child', input: 'Child', pins: {}, model: PARENT_MODEL });
    if (created.kind !== 'created') throw new Error(`child run was not created: ${created.kind}`);
    expect((await env.store.releaseLease(claim, { availableAt: env.clock.now() + 3_600_000 })).kind).toBe('ok');
    env.gateway.script.push(textStep('Never reached.'));
    await env.runOnce(env.worker());

    expect(env.run(created.run.id).status).toBe('FAILED');
    expect(env.run(created.run.id).error).toEqual({
      code: 'model_not_found',
      message: 'The model for subagents ("removed/model") is not configured any more. Choose another with /model, then Model settings…, then Models for other roles.',
    });
  });
});
