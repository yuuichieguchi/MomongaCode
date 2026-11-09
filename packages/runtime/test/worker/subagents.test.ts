import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNodeSkillFileSystem } from '@momonga/skills';
import { createAgentsPort, createChildRuns } from '@momonga/runtime';
import type { AgentsPort } from '@momonga/runtime';
import { createUnsandboxed } from '@momonga/sandbox';
import { REAL_PROCESS_TEST_TIMEOUT_MS, usageOf } from '@momonga/testkit';
import { LEASE_MS, makeEnv, textOf } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';
import { fixedSandboxBindings } from '@momonga/runtime';

const agentsPortOf = (env: Env, aliases: readonly string[] = ['fm']): AgentsPort =>
  createAgentsPort({
    home: env.home,
    fileSystem: createNodeSkillFileSystem(),
    settings: { trusted: () => env.settings.trustedValue },
    runs: createChildRuns({ store: env.store, modelAliases: async () => aliases }),
  });

const writeAgent = (env: Env, name: string, frontmatter = '', body = 'You review code.'): void => {
  const directory = path.join(env.project, '.momonga', 'agents');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${name}.md`), `---\nname: ${name}\ndescription: ${name} agent\n${frontmatter}---\n${body}\n`);
};

const delegate = (callId: string, agent = 'reviewer', prompt = 'Look at the diff') =>
  callsStep([{ callId, name: 'Agent', args: { description: 'review', prompt, subagent_type: agent } }]);

const toolNames = (env: Env, index: number): string[] =>
  (env.gateway.streams[index]?.body.tools ?? []).flatMap((tool) => (tool.type === 'function' ? [tool.name] : []));

const developerAndSystem = (env: Env, index: number): string => {
  const input = env.gateway.streams[index]?.body.input;
  return (Array.isArray(input) ? input : [])
    .filter((item) => item.type === 'message' && (item.role === 'developer' || item.role === 'system'))
    .map(textOf)
    .join('\n');
};

const instructionsOf = (env: Env, index: number): string => `${env.gateway.streams[index]?.body.instructions ?? ''}\n${developerAndSystem(env, index)}`;

describe('worker subagents', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('runs a child in its own context while the parent waits, then hands the child final text to the parent', async () => {
    const env = await makeEnv();
    writeAgent(env, 'reviewer', 'tools: Echo\n', 'You review code. Be terse.');
    const worker = env.worker('w1', { agents: agentsPortOf(env) });
    const parent = env.enqueue('Review my change');
    env.gateway.script.push(delegate('call-a'), textStep('child verdict: ship it'), textStep('parent done'));

    await env.runOnce(worker);
    expect(env.run(parent.id).status).toBe('WAITING_TOOL');
    expect(env.run(parent.id).leaseOwner).toBeNull();
    const [child] = env.store.listChildRuns(parent.id);
    if (child === undefined) throw new Error('the parent did not create a child run');
    expect(child).toMatchObject({ status: 'QUEUED', parentRunId: parent.id, history: 'fresh', deadlineAt: parent.deadlineAt });
    expect(child.sessionId).not.toBe(parent.sessionId);
    expect(env.ofType(parent.id, 'tool.waiting')).toMatchObject([{ awaits: { kind: 'run', runId: child.id, agent: 'reviewer' } }]);
    expect(toolNames(env, 0)).toContain('Agent');

    await env.runOnce(worker);
    expect(env.run(child.id).status).toBe('COMPLETED');
    expect(env.run(parent.id).status).toBe('QUEUED');
    expect(toolNames(env, 1)).toEqual(['Echo']);
    expect(instructionsOf(env, 1)).toContain('You review code. Be terse.');
    expect(instructionsOf(env, 1)).toContain('subagent "reviewer"');

    await env.runOnce(worker);
    expect(env.run(parent.id).status).toBe('COMPLETED');
    const completed = env.ofType(parent.id, 'tool.completed');
    expect(completed).toMatchObject([{ callId: expect.any(String), status: 'completed', output: 'child verdict: ship it' }]);
    expect(env.ofType(parent.id, 'tool.waiting')).toHaveLength(1);
    expect(env.gateway.streams).toHaveLength(3);
  });

  it('starts the child on the alias the parent pinned when the session alias is switched while the parent runs', async () => {
    const env = await makeEnv();
    writeAgent(env, 'reviewer');
    const parent = env.enqueue('Write then review');
    env.gateway.script.push(
      callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: path.join(env.project, 'out.txt'), content: 'x' } }]),
      delegate('call-a'),
    );
    await env.runOnce(env.worker('w1', { agents: agentsPortOf(env, ['fm', 'other-model']) }));
    expect(env.run(parent.id).status).toBe('WAITING_HUMAN');

    env.store.setModelAlias(env.session.id, 'other-model');
    await env.resolveApproval(parent.id, 'allow_once');
    await env.runOnce(env.worker('w2', { agents: agentsPortOf(env, ['fm', 'other-model']) }));

    const [child] = env.store.listChildRuns(parent.id);
    if (child === undefined) throw new Error('the parent did not create a child run');
    expect(env.store.getSession(env.session.id)?.modelAlias).toBe('other-model');
    expect(env.store.getSession(child.sessionId)?.modelAlias).toBe('fm');
  });

  it('runs the child of a plan-mode parent in plan mode, so a Write it attempts fails as not offered and nothing is written', async () => {
    const env = await makeEnv({ mode: 'plan' });
    writeAgent(env, 'writer', 'tools: Write\n', 'You write files.');
    const worker = env.worker('w1', { agents: agentsPortOf(env) });
    const parent = env.enqueue('Plan the change');
    const target = path.join(env.project, 'planted.txt');
    env.gateway.script.push(
      delegate('call-a', 'writer', 'Create planted.txt'),
      callsStep([{ callId: 'w1', name: 'Write', args: { file_path: target, content: 'planted' } }]),
      textStep('the write was refused'),
      textStep('parent done'),
    );

    for (let turn = 0; turn < 8 && env.run(parent.id).status !== 'COMPLETED'; turn += 1) await env.runOnce(worker);

    const [child] = env.store.listChildRuns(parent.id);
    if (child === undefined) throw new Error('the parent did not create a child run');
    expect(env.store.getSession(child.sessionId)?.permissionMode).toBe('plan');
    expect(fs.existsSync(target)).toBe(false);
    const completed = env.ofType(child.id, 'tool.completed');
    expect(completed).toMatchObject([{ status: 'failed', output: 'Tool "Write" was not offered in the request that produced this call, so it cannot run. Available tools: ' }]);
    expect(completed[0]).not.toHaveProperty('denial');
    expect(env.ofType(child.id, 'tool.permission.requested')).toEqual([]);
    expect(env.ofType(child.id, 'tool.started')).toEqual([]);
    expect(env.run(parent.id).status).toBe('COMPLETED');
  });

  it('keeps the parent waiting when it is woken before its child ends, without a second tool.waiting event', async () => {
    const env = await makeEnv();
    writeAgent(env, 'reviewer');
    const worker = env.worker('w1', { agents: agentsPortOf(env) });
    const parent = env.enqueue('Review');
    env.gateway.script.push(delegate('call-a'));
    await env.runOnce(worker);
    const [child] = env.store.listChildRuns(parent.id);
    if (child === undefined) throw new Error('missing child');
    await env.store.appendAsService(parent.id, env.run(parent.id).version, 'QUEUED', []);
    expect(env.run(parent.id).status).toBe('QUEUED');

    await env.runOnce(worker);
    expect(env.run(parent.id).status).toBe('WAITING_TOOL');
    expect(env.ofType(parent.id, 'tool.waiting')).toHaveLength(1);
    expect(env.store.listChildRuns(parent.id)).toHaveLength(1);
    expect(env.run(child.id).status).toBe('QUEUED');
  });

  it('runs several subagents of one response as separate child runs and answers each call', async () => {
    const env = await makeEnv();
    writeAgent(env, 'reviewer');
    writeAgent(env, 'tester');
    const worker = env.worker('w1', { agents: agentsPortOf(env) });
    const parent = env.enqueue('Do both');
    env.gateway.script.push(
      callsStep([
        { callId: 'a', name: 'Agent', args: { description: 'r', prompt: 'review', subagent_type: 'reviewer' } },
        { callId: 'b', name: 'Agent', args: { description: 't', prompt: 'test', subagent_type: 'tester' } },
      ]),
      textStep('reviewed'),
      textStep('tested'),
      textStep('all done'),
    );

    await env.runOnce(worker);
    expect(env.store.listChildRuns(parent.id)).toHaveLength(2);
    expect(env.run(parent.id).status).toBe('WAITING_TOOL');
    for (let turn = 0; turn < 8 && env.run(parent.id).status !== 'COMPLETED'; turn += 1) await env.runOnce(worker);
    expect(env.store.listChildRuns(parent.id).map((child) => child.status)).toEqual(['COMPLETED', 'COMPLETED']);
    expect(env.run(parent.id).status).toBe('COMPLETED');
    expect(env.ofType(parent.id, 'tool.completed').map((event) => event.output).sort()).toEqual(['reviewed', 'tested']);
  });

  it('does not offer the Agent tool to a subagent', async () => {
    const env = await makeEnv();
    writeAgent(env, 'reviewer');
    const worker = env.worker('w1', { agents: agentsPortOf(env) });
    env.enqueue('Review');
    env.gateway.script.push(delegate('call-a'), textStep('fine'), textStep('done'));
    await env.runOnce(worker);
    await env.runOnce(worker);
    expect(toolNames(env, 0)).toContain('Agent');
    expect(toolNames(env, 1)).not.toContain('Agent');
    expect(toolNames(env, 1)).toContain('Echo');
  });

  it('fails a subagent whose tool list names no existing tool and reports it to the parent', async () => {
    const env = await makeEnv();
    writeAgent(env, 'reviewer', 'tools: Nonexistent\n');
    const worker = env.worker('w1', { agents: agentsPortOf(env) });
    const parent = env.enqueue('Review');
    env.gateway.script.push(delegate('call-a'), textStep('sorry'));
    await env.runOnce(worker);
    await env.runOnce(worker);
    const [child] = env.store.listChildRuns(parent.id);
    expect(child).toMatchObject({ status: 'FAILED', error: { code: 'agent_without_tools' } });
    await env.runOnce(worker);
    expect(env.ofType(parent.id, 'tool.completed')).toMatchObject([{ status: 'failed', output: expect.stringContaining('agent_without_tools') }]);
  });

  it('refuses a subagent model alias that is not configured', async () => {
    const env = await makeEnv();
    writeAgent(env, 'reviewer', 'model: ghost\n');
    const worker = env.worker('w1', { agents: agentsPortOf(env, ['fm']) });
    const parent = env.enqueue('Review');
    env.gateway.script.push(delegate('call-a'), textStep('ok'));
    await env.runOnce(worker);
    expect(env.store.listChildRuns(parent.id)).toEqual([]);
    expect(env.ofType(parent.id, 'tool.completed')).toMatchObject([{ status: 'failed', output: expect.stringContaining('model alias "ghost"') }]);
  });

  it('counts the tokens of the children against the budget of the parent', async () => {
    const env = await makeEnv();
    writeAgent(env, 'reviewer');
    const worker = env.worker('w1', { agents: agentsPortOf(env) });
    const parent = env.enqueue('Review', { limits: { maxTotalTokens: 500 } });
    env.gateway.script.push(
      callsStep([{ callId: 'a', name: 'Agent', args: { description: 'r', prompt: 'review', subagent_type: 'reviewer' } }], usageOf(10, 5)),
      textStep('child spent a lot', { usage: usageOf(400, 100) }),
      textStep('wrap-up summary'),
    );
    await env.runOnce(worker);
    await env.runOnce(worker);
    expect(env.store.treeTokens(parent.id)).toBe(515);
    await env.runOnce(worker);
    expect(env.run(parent.id)).toMatchObject({ status: 'STOPPED', stopReason: 'budget' });
  });

  it('cancels the child when the parent is cancelled while it waits', async () => {
    const env = await makeEnv();
    writeAgent(env, 'reviewer');
    const worker = env.worker('w1', { agents: agentsPortOf(env) });
    const parent = env.enqueue('Review');
    env.gateway.script.push(delegate('call-a'));
    await env.runOnce(worker);
    const [child] = env.store.listChildRuns(parent.id);
    if (child === undefined) throw new Error('missing child');
    await env.cancel(parent.id);
    expect(env.run(child.id)).toMatchObject({ status: 'CANCELLING', cancelOrigin: 'QUEUED' });
    expect(await env.store.finishCancelled(() => undefined)).toEqual([child.id]);
    expect(env.run(child.id).status).toBe('CANCELLED');
    await env.runOnce(worker);
    expect(env.run(parent.id).status).toBe('CANCELLED');
    expect(env.gateway.streams).toHaveLength(1);
    expect(env.ofType(parent.id, 'tool.completed')).toMatchObject([{ status: 'failed', output: 'Subagent reviewer was cancelled.' }]);
    expect(env.ofType(parent.id, 'tool.reconciled')).toEqual([]);
    const key = env.fold(parent.id).pendingCalls[Object.keys(env.fold(parent.id).pendingCalls)[0] as string]?.idemKey ?? '';
    expect(env.store.idempotency.get(key)).toMatchObject({ s: 'COMPLETED' });
  });

  it('hands the real result of a child that finished before the cancel to the parent instead of a cancelled statement', async () => {
    const env = await makeEnv();
    writeAgent(env, 'reviewer');
    const worker = env.worker('w1', { agents: agentsPortOf(env) });
    const parent = env.enqueue('Review');
    env.gateway.script.push(delegate('call-a'), textStep('child verdict: ship it'));
    await env.runOnce(worker);
    await env.runOnce(worker);
    const [child] = env.store.listChildRuns(parent.id);
    expect(env.run(child?.id ?? '').status).toBe('COMPLETED');
    expect(env.run(parent.id).status).toBe('QUEUED');
    expect(env.store.claim('crashing-worker')?.runId).toBe(parent.id);
    env.clock.advance(LEASE_MS + 1);
    expect((await env.cancel(parent.id)).status).toBe('CANCELLING');

    await env.runOnce(worker);

    expect(env.run(parent.id).status).toBe('CANCELLED');
    expect(env.ofType(parent.id, 'tool.completed')).toMatchObject([{ status: 'completed', output: 'child verdict: ship it' }]);
    const key = env.fold(parent.id).pendingCalls[Object.keys(env.fold(parent.id).pendingCalls)[0] as string]?.idemKey ?? '';
    expect(env.store.idempotency.get(key)).toMatchObject({ s: 'COMPLETED', result: { kind: 'result', result: { status: 'completed', output: 'child verdict: ship it' } } });
  });

  it('runs the SessionStart, UserPromptSubmit and Stop hooks for the main run only, not for its subagent', async () => {
    const env = await makeEnv();
    writeAgent(env, 'reviewer');
    const counter = path.join(env.project, 'hook-runs.txt');
    const hook = (event: string) => [{ hooks: [{ type: 'command' as const, command: `echo ${event} >> ${counter}` }] }];
    env.settings.hooksValue = { SessionStart: hook('SessionStart'), UserPromptSubmit: hook('UserPromptSubmit'), Stop: hook('Stop') };
    const worker = env.worker('w1', { agents: agentsPortOf(env), tools: { sandboxes: fixedSandboxBindings(createUnsandboxed({ killGraceMs: 200 })) } });
    const parent = env.enqueue('Review');
    env.gateway.script.push(delegate('call-a'), textStep('child verdict'), textStep('parent done'));

    await env.runOnce(worker);
    await env.runOnce(worker);
    await env.runOnce(worker);

    expect(env.run(parent.id).status).toBe('COMPLETED');
    expect(fs.readFileSync(counter, 'utf8').trim().split('\n').sort()).toEqual(['SessionStart', 'Stop', 'UserPromptSubmit']);
    const [child] = env.store.listChildRuns(parent.id);
    expect(env.ofType(child?.id ?? '', 'hook.completed')).toEqual([]);
  });

  it('stops the parent and its child at their shared deadline while the parent waits', async () => {
    const env = await makeEnv();
    writeAgent(env, 'reviewer');
    const worker = env.worker('w1', { agents: agentsPortOf(env) });
    const parent = env.enqueue('Review');
    env.gateway.script.push(delegate('call-a'));
    await env.runOnce(worker);
    const [child] = env.store.listChildRuns(parent.id);
    if (child === undefined) throw new Error('missing child');
    env.clock.set(parent.deadlineAt);
    expect(await env.store.expireApprovals(env.clock.now(), (error: unknown) => { throw error; })).toContain(parent.id);
    await env.runOnce(worker);
    expect(env.run(parent.id)).toMatchObject({ status: 'STOPPED', stopReason: 'timeout' });
    expect(env.run(child.id)).toMatchObject({ status: 'STOPPED', stopReason: 'timeout' });
  });

  it('recovers a parent that crashed after starting the Agent call without creating a second child', async () => {
    const env = await makeEnv();
    writeAgent(env, 'reviewer');
    const crashing = env.worker('w1', { agents: agentsPortOf(env) });
    const parent = env.enqueue('Review');
    env.gateway.script.push(delegate('call-a'), textStep('child text'), textStep('parent done'));
    await env.runOnce(crashing);
    const [child] = env.store.listChildRuns(parent.id);
    if (child === undefined) throw new Error('missing child');
    const waitingRun = env.run(parent.id);
    env.raw().prepare("UPDATE runs SET status = 'RUNNING', lease_owner = 'dead', lease_expires_at = ?, available_at = ? WHERE id = ?").run(env.clock.now() - 1, env.clock.now(), waitingRun.id);

    const recovering = env.worker('w2', { agents: agentsPortOf(env) });
    await env.runOnce(recovering);
    expect(env.store.listChildRuns(parent.id)).toHaveLength(1);
    expect(env.run(parent.id).status).toBe('WAITING_TOOL');
    await env.runOnce(recovering);
    await env.runOnce(recovering);
    expect(env.run(parent.id).status).toBe('COMPLETED');
    expect(env.ofType(parent.id, 'tool.completed')).toMatchObject([{ output: 'child text' }]);
  });

  it('hides project agents in an untrusted folder', async () => {
    const env = await makeEnv();
    env.settings.trustedValue = false;
    writeAgent(env, 'reviewer');
    const worker = env.worker('w1', { agents: agentsPortOf(env) });
    const parent = env.enqueue('Review');
    env.gateway.script.push(textStep('ok'));
    await env.runOnce(worker);
    expect(toolNames(env, 0)).not.toContain('Agent');
    expect(env.ofType(parent.id, 'notice').map((event) => event.message).join('\n')).toContain('not trusted');
  });
});

