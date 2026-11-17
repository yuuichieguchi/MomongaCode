import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import { createMcpToolSource } from '@momonga/mcp';
import type { McpServerConnection } from '@momonga/mcp';
import { createNodeSkillFileSystem } from '@momonga/skills';
import { createAgentsPort, createChildRuns } from '@momonga/runtime';
import type { AgentsPort } from '@momonga/runtime';
import type { AnyTool } from '@momonga/tools';
import { upstreamIdleText } from '@momonga/gateway';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';
import type { ScriptStep } from './fake-gateway.ts';
import { keepAliveOnly, startRealGateway, within } from './keep-alive-gateway.ts';
import { fakeViewsOf } from './fake-gateway.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const MODEL_IDLE_MS = 300;
const MCP_IDLE_MS = 150;
const REFUNDED_CUT_STREAMS = 3;
const CHILD_IDLE_STOPS = REFUNDED_CUT_STREAMS + 1;
const MCP_IDLE_TEXT = `MCP server "jobs" sent no response or progress for ${MCP_IDLE_MS} ms, so the call to long_job was stopped. The server may have run it; check before repeating it. To wait longer, raise mcp.toolIdleTimeoutNetworkMs.`;

const agentsPortOf = (env: Env): AgentsPort =>
  createAgentsPort({
    home: env.home,
    fileSystem: createNodeSkillFileSystem(),
    settings: { trusted: async () => env.settings.trustedValue, approvedProjectAgents: async () => ({ has: () => true }) },
    runs: createChildRuns({ store: env.store, modelViews: async () => fakeViewsOf(['fm']) }),
  });

const writeAgent = (env: Env): void => {
  const directory = path.join(env.project, '.momonga', 'agents');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'worker.md'), '---\nname: worker\ndescription: worker agent\n---\nYou do the work.\n');
};

const delegate = (callId: string): ScriptStep => callsStep([{ callId, name: 'Agent', args: { description: 'work', prompt: 'Do it', subagent_type: 'worker' } }]);

const silentMcpTool = async (): Promise<AnyTool> => {
  const tool: Tool = { name: 'long_job', inputSchema: { type: 'object', properties: {} } };
  const connection: McpServerConnection = {
    name: 'jobs',
    transportKind: 'network',
    protocolVersion: undefined,
    protocolEra: undefined,
    serverInfo: undefined,
    instructions: undefined,
    listTools: async () => [tool],
    callTool: (input) =>
      new Promise<CallToolResult>((resolve) => input.signal?.addEventListener('abort', () => resolve({ content: [{ type: 'text', text: 'late' }] }), { once: true })),
    releaseCheckpoint: async () => undefined,
    cancelOutcome: () => undefined,
    redact: (text) => text,
    diagnostics: () => ({ server: 'jobs', state: 'connected', pgid: undefined, protocolVersion: undefined, lastError: null, stderrTail: '', exit: null }),
    close: async () => undefined,
  };
  const [listed] = await createMcpToolSource({ server: 'jobs', connection, toolIdleTimeoutMs: MCP_IDLE_MS }).list();
  if (listed === undefined) throw new Error('the fake server lists one tool');
  return listed;
};

const untilTerminal = async (env: Env, worker: ReturnType<Env['worker']>, runId: string): Promise<void> => {
  for (let cycle = 0; cycle < 20; cycle += 1) {
    const current = env.run(runId);
    if (['COMPLETED', 'FAILED', 'STOPPED', 'CANCELLED'].includes(current.status)) return;
    env.clock.set(Math.max(env.clock.now(), current.availableAt));
    await env.runOnce(worker);
  }
  throw new Error(`run ${runId} did not end: ${env.run(runId).status}`);
};

const untilAsked = async (env: Env, worker: ReturnType<Env['worker']>, runId: string): Promise<void> => {
  for (let cycle = 0; cycle < 20; cycle += 1) {
    const current = env.run(runId);
    if (current.status === 'WAITING_HUMAN') return;
    env.clock.set(Math.max(env.clock.now(), current.availableAt));
    await env.runOnce(worker);
  }
  throw new Error(`run ${runId} did not ask: ${env.run(runId).status}`);
};

describe('G3: the subagent wait is bounded by the bounds of the child steps (R-G3)', () => {
  it('test 1: a child whose model only sends keep-alives ends by the real gateway idle stop, and the parent wait ends with that failure', async () => {
    const env = await makeEnv({ maxAttempts: 1, maxTotalAttempts: 1 });
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    writeAgent(env);
    const real = await startRealGateway({ clock: env.clock, idleTimeoutMs: MODEL_IDLE_MS, script: Array.from({ length: CHILD_IDLE_STOPS }, () => keepAliveOnly) });
    const parentWorker = env.worker('w1', { agents: agentsPortOf(env) });
    const childWorker = env.worker('w2', { agents: agentsPortOf(env), gateway: real.client });
    const parent = await env.enqueue('Delegate');
    env.gateway.script.push(delegate('call-a'), textStep('parent done'));
    await env.runOnce(parentWorker);
    expect(env.run(parent.id).status).toBe('WAITING_TOOL');
    const [child] = env.store.listChildRuns(parent.id);
    if (child === undefined) throw new Error('the parent did not create a child run');
    expect(await within(untilTerminal(env, childWorker, child.id), CHILD_IDLE_STOPS * 10 * MODEL_IDLE_MS)).toEqual({ settled: true, value: undefined });
    const ended = env.run(child.id);
    expect(ended.status).toBe('FAILED');
    expect(ended.error?.message).toContain(upstreamIdleText(MODEL_IDLE_MS));
    expect(real.upstream.requests.filter((request) => request.path === '/v1/chat/completions')).toHaveLength(CHILD_IDLE_STOPS);
    expect(env.run(parent.id).status).toBe('QUEUED');
    await untilTerminal(env, parentWorker, parent.id);
    const [completed] = env.ofType(parent.id, 'tool.completed');
    expect(completed).toMatchObject({ status: 'failed' });
    expect((completed as { output: string }).output).toContain(upstreamIdleText(MODEL_IDLE_MS));
    expect(env.clock.now()).toBeLessThan(parent.deadlineAt);
  });

  it('test 2: a child whose MCP call never answers ends that call at the G2 idle window, the unknown effect asks the person on the child run, and the parent wait ends when the child ends', async () => {
    const env = await makeEnv();
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    env.settings.stored.push({ effect: 'allow', rule: 'mcp__jobs__long_job' });
    writeAgent(env);
    const mcpTool = await silentMcpTool();
    const worker = env.worker('w1', { agents: agentsPortOf(env), toolList: () => [mcpTool] });
    const parent = await env.enqueue('Delegate');
    env.gateway.script.push(delegate('call-a'), callsStep([{ callId: 'call-m', name: 'mcp__jobs__long_job', args: {} }]), textStep('the job did not answer'), textStep('parent done'));
    await env.runOnce(worker);
    const [child] = env.store.listChildRuns(parent.id);
    if (child === undefined) throw new Error('the parent did not create a child run');
    expect(await within(untilAsked(env, worker, child.id), 20 * MCP_IDLE_MS)).toEqual({ settled: true, value: undefined });
    expect(JSON.stringify(env.ofType(child.id, 'tool.reconciled'))).toContain(JSON.stringify(MCP_IDLE_TEXT));
    const asks = await env.store.pendingApprovalViews(child.id);
    expect(asks.map((ask) => ask.kind)).toEqual(['unknown_effect']);
    const answered = await env.store.resolveApproval(asks[0]?.id ?? '', 'allow_once');
    expect(answered.kind).toBe('ok');

    await untilTerminal(env, worker, child.id);

    expect(env.run(child.id).status).toBe('COMPLETED');
    await untilTerminal(env, worker, parent.id);
    expect(env.ofType(parent.id, 'tool.completed')).toMatchObject([
      { status: 'completed', output: 'the job did not answer\nResidual risk:\n- no_condition_declared_after_mutation: 1\n- mutation_without_known_paths: 1\n- unknown_effect_calls: 1' },
    ]);
  });

  it('test 3: depth 1 by behaviour: a child that calls Agent is refused, so no grandchild run exists', async () => {
    const env = await makeEnv();
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    writeAgent(env);
    const worker = env.worker('w1', { agents: agentsPortOf(env) });
    const parent = await env.enqueue('Delegate');
    env.gateway.script.push(delegate('call-a'), delegate('call-b'), textStep('child gave up'), textStep('parent done'));
    await env.runOnce(worker);
    const [child] = env.store.listChildRuns(parent.id);
    if (child === undefined) throw new Error('the parent did not create a child run');
    await untilTerminal(env, worker, child.id);
    expect(env.store.listChildRuns(child.id)).toEqual([]);
    expect(env.ofType(child.id, 'tool.completed')).toMatchObject([{ status: 'failed' }]);
    expect(env.run(child.id).limits).toEqual(env.run(parent.id).limits);
  });
});
