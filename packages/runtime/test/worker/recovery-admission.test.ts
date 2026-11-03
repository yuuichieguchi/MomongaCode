import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { createToolRegistry } from '@momonga/tools';
import { START_MS, makeEnv, toolKey } from './harness.ts';
import { callsStep, functionCallItem, textStep } from './scripts.ts';

const TOOLS_CHANGED = 'The available tools changed since this run started';

describe('worker tool-set notice', () => {
  it('appends the changed-tools notice once per run across attempts', async () => {
    const env = await makeEnv();
    const first = path.join(env.project, 'first.txt');
    const second = path.join(env.project, 'second.txt');
    const reduced = () => env.toolbox.tools().filter((tool) => tool.name !== 'Probe');
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: first, content: 'one' } }]));
    const run = env.enqueue('Write two files');
    await env.runOnce(env.worker('worker-1'));
    env.resolveApproval(run.id, 'allow_once');
    env.gateway.script.push(callsStep([{ callId: 'call_w_2', name: 'Write', args: { file_path: second, content: 'two' } }]));
    await env.runOnce(env.worker('worker-2', { toolList: reduced }));
    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    env.resolveApproval(run.id, 'allow_once');
    env.gateway.script.push(textStep('Both written.'));

    await env.runOnce(env.worker('worker-3', { toolList: reduced }));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'notice').filter((notice) => notice.message.startsWith(TOOLS_CHANGED))).toHaveLength(1);
  });

  it('recognises the changed-tools notice by its code, whatever its text was', async () => {
    const env = await makeEnv();
    const first = path.join(env.project, 'first.txt');
    const second = path.join(env.project, 'second.txt');
    const reduced = () => env.toolbox.tools().filter((tool) => tool.name !== 'Probe');
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: first, content: 'one' } }]));
    const run = env.enqueue('Write two files');
    await env.runOnce(env.worker('worker-1'));
    const appended = env.store.appendAsService(run.id, env.run(run.id).version, null, [
      { type: 'notice', level: 'warning', message: 'The tool set differs from the one this run started with.', code: 'tools_changed' },
    ]);
    expect(appended.kind).toBe('ok');
    env.resolveApproval(run.id, 'allow_once');
    env.gateway.script.push(callsStep([{ callId: 'call_w_2', name: 'Write', args: { file_path: second, content: 'two' } }]));

    await env.runOnce(env.worker('worker-2', { toolList: reduced }));

    expect(env.ofType(run.id, 'notice').filter((notice) => notice.code === 'tools_changed')).toHaveLength(1);
  });
});

describe('worker MCP authorization notice', () => {
  it('records the notice and the authorization event once per run across attempts', async () => {
    const env = await makeEnv();
    const first = path.join(env.project, 'first.txt');
    const second = path.join(env.project, 'second.txt');
    const tools = {
      toolSet: async () => {
        const registry = createToolRegistry();
        for (const tool of env.toolbox.tools()) registry.register(tool);
        registry.addSource({
          id: 'remote',
          list: async () => [],
          listWithNotices: async () => ({ tools: [], notices: [], authorizationRequired: ['remote'] }),
        });
        return registry.snapshot();
      },
    };
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: first, content: 'one' } }]));
    const run = env.enqueue('Write two files');
    await env.runOnce(env.worker('worker-1', { tools }));
    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    env.resolveApproval(run.id, 'allow_once');
    env.gateway.script.push(callsStep([{ callId: 'call_w_2', name: 'Write', args: { file_path: second, content: 'two' } }]));
    await env.runOnce(env.worker('worker-2', { tools }));
    env.resolveApproval(run.id, 'allow_once');
    env.gateway.script.push(textStep('Both written.'));

    await env.runOnce(env.worker('worker-3', { tools }));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'notice').filter((notice) => notice.code === 'mcp_authorization_required')).toHaveLength(1);
    expect(env.ofType(run.id, 'mcp.authorization.required')).toEqual([expect.objectContaining({ server: 'remote' })]);
  });
});

describe('worker recovery of a started call with an existing record', () => {
  it('reconciles without asking again even though the mode became stricter', async () => {
    const env = await makeEnv({ mode: 'acceptEdits' });
    const target = path.join(env.project, 'out.txt');
    const run = env.enqueue('Write the file');
    const key = toolKey(run.id, 1, 'call_w_1');
    const payloads: RunEventPayload[] = [
      {
        type: 'model.responded',
        step: 1,
        attempt: 1,
        response: {
          status: 'completed',
          output: [functionCallItem({ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'x' } })],
          usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 },
        },
      },
      { type: 'tool.call', callId: 'call_w_1', providerCallId: 'call_w_1', name: 'Write', kind: 'edit', title: `Write ${target}`, rawInput: { file_path: target, content: 'x' } },
      { type: 'tool.started', callId: 'call_w_1', idemKey: key },
    ];
    env.seed(run.id, payloads, 'crash');
    env.store.idempotency.begin(key, { expiresAt: START_MS + 86_400_000, meta: { tool: 'Write' } });
    env.setMode('default');
    env.gateway.script.push(textStep('Checked.'));

    await env.runOnce(env.worker());

    expect(env.ofType(run.id, 'tool.permission.requested')).toEqual([]);
    expect(env.store.approvals.listPending(run.id)).toEqual([]);
    expect(env.ofType(run.id, 'tool.reconciled')).toEqual([expect.objectContaining({ callId: 'call_w_1', outcome: 'unknown' })]);
    expect(env.toolbox.executions).toEqual([]);
    expect(env.run(run.id).status).toBe('COMPLETED');
  });
});
