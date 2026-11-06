import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import { createMcpToolSource } from '@momonga/mcp';
import type { McpServerConnection } from '@momonga/mcp';
import { createNodeSkillFileSystem } from '@momonga/skills';
import { GatewayRequestError, createAgentsPort, createChildRuns } from '@momonga/runtime';
import type { AgentsPort } from '@momonga/runtime';
import type { AnyTool } from '@momonga/tools';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';
import type { ScriptStep } from './fake-gateway.ts';

const MODEL_IDLE_TEXT = 'The model sent no output for 300 s (only keep-alive signals arrived), so the call was stopped. Raise models.idleTimeoutMs if this model needs longer.';
const IDLE_MS = 150;
const MCP_IDLE_TEXT = `MCP server "jobs" sent no response or progress for ${IDLE_MS} ms, so the call to long_job was stopped. The server may have run it; check before repeating it. To wait longer, raise mcp.toolIdleTimeoutMs.`;

const agentsPortOf = (env: Env): AgentsPort =>
  createAgentsPort({
    home: env.home,
    fileSystem: createNodeSkillFileSystem(),
    settings: { trusted: () => env.settings.trustedValue },
    runs: createChildRuns({ store: env.store, modelAliases: async () => ['fm'] }),
  });

const writeAgent = (env: Env): void => {
  const directory = path.join(env.project, '.momonga', 'agents');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'worker.md'), '---\nname: worker\ndescription: worker agent\n---\nYou do the work.\n');
};

const delegate = (callId: string): ScriptStep => callsStep([{ callId, name: 'Agent', args: { description: 'work', prompt: 'Do it', subagent_type: 'worker' } }]);

const idleStop = (): ScriptStep => ({ events: [], error: new GatewayRequestError({ status: 502, type: 'server_error', code: 'stream_interrupted', message: MODEL_IDLE_TEXT }) });

const silentMcpTool = async (): Promise<AnyTool> => {
  const tool: Tool = { name: 'long_job', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } };
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
    diagnostics: () => ({ server: 'jobs', state: 'connected', pgid: undefined, protocolVersion: undefined, lastError: null, stderrTail: '' }),
    close: async () => undefined,
  };
  const [listed] = await createMcpToolSource({ server: 'jobs', connection, toolIdleTimeoutMs: IDLE_MS }).list();
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

describe('G3: the subagent wait is bounded by the bounds of the child steps (R-G3)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('test 1: a child whose model only sends keep-alives ends by the G1 stop, and the parent wait ends with that failure', async () => {
    const env = await makeEnv({ maxAttempts: 1, maxTotalAttempts: 1 });
    writeAgent(env);
    const worker = env.worker('w1', { agents: agentsPortOf(env) });
    const parent = env.enqueue('Delegate');
    env.gateway.script.push(delegate('call-a'), idleStop(), idleStop(), idleStop(), idleStop(), idleStop(), textStep('parent done'));
    await env.runOnce(worker);
    expect(env.run(parent.id).status).toBe('WAITING_TOOL');
    const [child] = env.store.listChildRuns(parent.id);
    if (child === undefined) throw new Error('the parent did not create a child run');
    await untilTerminal(env, worker, child.id);
    const ended = env.run(child.id);
    expect(ended.status).toBe('FAILED');
    expect(ended.error?.message).toContain(MODEL_IDLE_TEXT);
    expect(env.run(parent.id).status).toBe('QUEUED');
    await untilTerminal(env, worker, parent.id);
    const [completed] = env.ofType(parent.id, 'tool.completed');
    expect(completed).toMatchObject({ status: 'failed' });
    expect((completed as { output: string }).output).toContain(MODEL_IDLE_TEXT);
    expect(env.clock.now()).toBeLessThan(parent.deadlineAt);
  });

  it('test 2: a child whose MCP call never answers ends that call at the G2 idle window, and the parent wait ends when the child ends', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    writeAgent(env);
    const mcpTool = await silentMcpTool();
    const worker = env.worker('w1', { agents: agentsPortOf(env), toolList: () => [mcpTool] });
    const parent = env.enqueue('Delegate');
    env.gateway.script.push(delegate('call-a'), callsStep([{ callId: 'call-m', name: 'mcp__jobs__long_job', args: {} }]), textStep('the job did not answer'), textStep('parent done'));
    await env.runOnce(worker);
    const [child] = env.store.listChildRuns(parent.id);
    if (child === undefined) throw new Error('the parent did not create a child run');
    await untilTerminal(env, worker, child.id);
    expect(JSON.stringify(env.ofType(child.id, 'tool.reconciled'))).toContain(JSON.stringify(MCP_IDLE_TEXT));
    expect(env.run(child.id).status).toBe('COMPLETED');
    await untilTerminal(env, worker, parent.id);
    expect(env.ofType(parent.id, 'tool.completed')).toMatchObject([{ status: 'completed', output: 'the job did not answer' }]);
  });

  it('test 3: depth 1 by behaviour: a child that calls Agent is refused, so no grandchild run exists', async () => {
    const env = await makeEnv();
    writeAgent(env);
    const worker = env.worker('w1', { agents: agentsPortOf(env) });
    const parent = env.enqueue('Delegate');
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
