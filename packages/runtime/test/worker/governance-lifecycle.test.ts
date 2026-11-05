import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNodeSkillFileSystem } from '@momonga/skills';
import { createAgentsPort, createChildRuns, createGovernancePort } from '@momonga/runtime';
import { defineTool } from '@momonga/tools';
import type { AgentsPort, GovernancePort } from '@momonga/runtime';
import { LEASE_MS, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const agentsPortOf = (env: Env): AgentsPort =>
  createAgentsPort({
    home: env.home,
    fileSystem: createNodeSkillFileSystem(),
    settings: { trusted: () => env.settings.trustedValue },
    runs: createChildRuns({ store: env.store, modelAliases: async () => ['fm'] }),
  });

const writeAgent = (env: Env, name: string, tools: string): void => {
  const directory = path.join(env.project, '.momonga', 'agents');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${name}.md`), `---\nname: ${name}\ndescription: ${name} agent\ntools: ${tools}\n---\nYou propose rules.\n`);
};

const proposal = (callId: string) =>
  callsStep([{ callId, name: 'RulePropose', args: { kind: 'constraint', target: 'pandas', text: 'Never use pandas.', scope: 'project' } }]);

describe('RulePropose in a delegated run', () => {
  it('leaves the child waiting for a person and the parent waiting for the child, and adds the rule only after the person approves', async () => {
    const env = await makeEnv();
    writeAgent(env, 'proposer', 'RulePropose');
    const governance = createGovernancePort({ store: env.store, settings: env.settings });
    const worker = env.worker('w1', { agents: agentsPortOf(env), governance });
    const parent = env.enqueue('Have the proposer add the rule');
    env.gateway.script.push(
      callsStep([{ callId: 'call-a', name: 'Agent', args: { description: 'propose', prompt: 'Propose never using pandas', subagent_type: 'proposer' } }]),
      proposal('call-p'),
    );

    await env.runOnce(worker);
    await env.runOnce(worker);

    const [child] = env.store.listChildRuns(parent.id);
    if (child === undefined) throw new Error('the parent did not create a child run');
    expect(env.run(child.id).status).toBe('WAITING_HUMAN');
    expect(env.run(parent.id).status).toBe('WAITING_TOOL');
    expect(env.store.governing.list()).toEqual([]);
    const [request] = env.ofType(child.id, 'tool.permission.requested');
    expect(request?.options.map((option) => option.kind)).toEqual(['allow_once', 'reject_once']);
    expect(request).not.toHaveProperty('suggestedRule');

    const walked = env.store.listChildRuns(parent.id).flatMap((run) => env.store.pendingApprovalViews(run.id));
    expect(walked).toHaveLength(1);
    expect(walked[0]).toMatchObject({ runId: child.id, toolCall: { name: 'RulePropose' } });
    expect(walked[0]?.toolCall.title).toContain('Never use pandas.');
    expect(walked[0]?.options.map((option) => option.kind)).toEqual(['allow_once', 'reject_once']);
    expect(env.store.pendingApprovalViews(parent.id)).toEqual([]);

    await env.resolveApproval(child.id, 'allow_once');
    env.gateway.script.push(textStep('proposed'), textStep('parent done'));
    for (let turn = 0; turn < 6 && env.run(parent.id).status !== 'COMPLETED'; turn += 1) await env.runOnce(worker);

    expect(env.run(parent.id).status).toBe('COMPLETED');
    expect(env.store.governing.list()).toHaveLength(1);
    expect(env.store.governing.list()[0]?.source).toMatchObject({ kind: 'proposal', runId: child.id });
  });
});

describe('a rule retired during a live run', () => {
  it('gives the model back the tool the rule had hidden at the next build', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const fact = env.store.governing.add({
      kind: 'constraint',
      target: 'glob',
      text: 'Do not use Glob.',
      scope: { level: 'project', project: env.session.cwd, paths: [] },
      validUntil: null,
      supersedes: [],
      enforcement: { behavior: 'deny', rule: 'Glob' },
      source: { kind: 'command' },
    }).fact;
    const globbing = defineTool<Record<string, never>>({
      name: 'Glob',
      description: 'Finds files',
      kind: 'search',
      sideEffect: 'read_only',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      timeoutMs: 60_000,
      title: () => 'Glob',
      subject: () => ({ kind: 'none', tool: 'Glob' }),
      execute: async () => ({ status: 'completed', output: 'none' }),
    });
    const retiring = defineTool<Record<string, never>>({
      name: 'Retire',
      description: 'Retires the rule',
      kind: 'other',
      sideEffect: 'read_only',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      timeoutMs: 60_000,
      title: () => 'Retire',
      subject: () => ({ kind: 'none', tool: 'Retire' }),
      execute: async () => {
        env.store.governing.retire(fact.id);
        return { status: 'completed', output: 'retired' };
      },
    });
    env.gateway.script.push(callsStep([{ callId: 'call_r_1', name: 'Retire', args: {} }]), textStep('Done.'));
    const run = env.enqueue('Retire the rule');
    await env.runOnce(env.worker('w1', { toolList: () => [globbing, retiring], governance: createGovernancePort({ store: env.store, settings: env.settings }) }));

    expect(env.run(run.id).status).toBe('COMPLETED');
    const names = (index: number): string[] => (env.gateway.streams[index]?.body.tools as { name: string }[]).map((tool) => tool.name);
    expect(names(0)).not.toContain('Glob');
    expect(names(0)).toContain('Retire');
    expect(names(1)).toContain('Glob');
  });
});

describe('RulePropose after a crash', () => {
  it('replays the approved call through a real worker and adds the rule once', async () => {
    const env = await makeEnv();
    const real = createGovernancePort({ store: env.store, settings: env.settings });
    env.gateway.script.push(proposal('call-p'));
    const run = env.enqueue('Add the rule');
    await env.runOnce(env.worker('w1', { governance: real }));
    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    await env.resolveApproval(run.id, 'allow_once');

    const crashing: GovernancePort = {
      load: (session) => ({
        tools: real.load(session).tools.map((tool) => ({
          ...tool,
          execute: async (input, ctx, prepared) => {
            const result = await tool.execute(input, ctx, prepared);
            env.clock.advance(LEASE_MS + 1);
            const thief = env.store.claim('thief');
            if (thief === null) throw new Error('the lease did not expire');
            env.store.release(thief, 'QUEUED');
            return result;
          },
        })),
      }),
    };
    await env.runOnce(env.worker('w2', { governance: crashing }));
    expect(env.store.governing.list()).toHaveLength(1);
    expect(env.ofType(run.id, 'tool.completed')).toEqual([]);

    env.gateway.script.push(textStep('Added.'));
    await env.runOnce(env.worker('w3', { governance: real }));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.store.governing.list()).toHaveLength(1);
    const [fact] = env.store.governing.list();
    expect(env.ofType(run.id, 'tool.reconciled')[0]).toMatchObject({ outcome: 'already_applied', output: `Rule ${fact?.id} was already added.` });
  });
});
