import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { createToolRegistry, defineTool } from '@momonga/tools';
import { START_MS, makeEnv, toolKey } from './harness.ts';
import { callsStep, functionCallItem, requestedOffering, textStep } from './scripts.ts';

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
    await env.resolveApproval(run.id, 'allow_once');
    env.gateway.script.push(callsStep([{ callId: 'call_w_2', name: 'Write', args: { file_path: second, content: 'two' } }]));
    await env.runOnce(env.worker('worker-2', { toolList: reduced }));
    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    await env.resolveApproval(run.id, 'allow_once');
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
    expect((await appended).kind).toBe('ok');
    await env.resolveApproval(run.id, 'allow_once');
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
    await env.resolveApproval(run.id, 'allow_once');
    env.gateway.script.push(callsStep([{ callId: 'call_w_2', name: 'Write', args: { file_path: second, content: 'two' } }]));
    await env.runOnce(env.worker('worker-2', { tools }));
    await env.resolveApproval(run.id, 'allow_once');
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
      requestedOffering(1, ['Write']),
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
    await env.seed(run.id, payloads, 'crash');
    env.store.idempotency.begin(key, { expiresAt: START_MS + 86_400_000, meta: { tool: 'Write' } });
    env.setMode('manual');
    env.gateway.script.push(textStep('Checked.'));

    await env.runOnce(env.worker());

    expect(env.ofType(run.id, 'tool.permission.requested')).toEqual([]);
    expect(env.store.approvals.listPending(run.id)).toEqual([]);
    expect(env.ofType(run.id, 'tool.reconciled')).toEqual([expect.objectContaining({ callId: 'call_w_1', outcome: 'unknown' })]);
    expect(env.toolbox.executions).toEqual([]);
    expect(env.run(run.id).status).toBe('COMPLETED');
  });
});

const jobTool = (name: string, sideEffect: 'read_only' | 'write') =>
  defineTool<Record<string, unknown>>({
    name,
    description: `${name} test tool`,
    kind: 'execute',
    sideEffect,
    subjectKind: 'none',
    companionOf: 'Bash',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: 1000,
    title: () => name,
    subject: () => ({ kind: 'none', tool: name }),
    execute: async () => ({ status: 'completed', output: 'ok' }),
  });

const JOB_TOOLS = ['BashOutput', 'KillBash'];

describe('worker offering of the job tools', () => {
  const namesOf = (env: Awaited<ReturnType<typeof makeEnv>>, index: number): string[] =>
    (env.gateway.streams[index]?.body.tools ?? []).flatMap((tool) => (tool.type === 'function' ? [tool.name] : []));

  const withJobTools = (env: Awaited<ReturnType<typeof makeEnv>>) => () => [...env.toolbox.tools(), jobTool('BashOutput', 'read_only'), jobTool('KillBash', 'write')];

  const startJob = (env: Awaited<ReturnType<typeof makeEnv>>, runId: string): string => {
    const id = 'bash_aaaaaaaaaaaa';
    env.store.jobs.start({ id, idemKey: 'k'.repeat(64), sessionId: env.session.id, runId, callId: 'c', command: 'sleep 100' });
    return id;
  };

  it('offers neither job tool when Bash is denied and the session has no job', async () => {
    const env = await makeEnv();
    env.settings.extraRules.push({ effect: 'deny', rule: 'Bash' });
    env.gateway.script.push(textStep('done'));
    env.enqueue('Work');

    await env.runOnce(env.worker('w1', { toolList: withJobTools(env) }));

    expect(namesOf(env, 0)).toContain('Echo');
    expect(namesOf(env, 0).filter((name) => name === 'Bash' || JOB_TOOLS.includes(name))).toEqual([]);
  });

  it('offers both job tools when Bash is denied and a job runs, also after recovery by another worker', async () => {
    const env = await makeEnv();
    env.settings.extraRules.push({ effect: 'deny', rule: 'Bash' });
    const first = path.join(env.project, 'first.txt');
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: first, content: 'one' } }]));
    const run = env.enqueue('Write a file');
    startJob(env, run.id);
    await env.runOnce(env.worker('w1', { toolList: withJobTools(env) }));
    await env.resolveApproval(run.id, 'allow_once');
    env.gateway.script.push(textStep('Written.'));

    await env.runOnce(env.worker('w2', { toolList: withJobTools(env) }));

    for (const index of [0, 1]) {
      expect(namesOf(env, index)).not.toContain('Bash');
      expect(namesOf(env, index).filter((name) => JOB_TOOLS.includes(name))).toEqual(JOB_TOOLS);
    }
    expect(env.ofType(run.id, 'notice').filter((notice) => notice.code === 'tools_changed')).toEqual([]);
  });

  it('offers both job tools in a later run of the same session while a job of the session is still running and Bash is denied', async () => {
    const env = await makeEnv();
    env.settings.extraRules.push({ effect: 'deny', rule: 'Bash' });
    env.gateway.script.push(textStep('first done'));
    const earlier = env.enqueue('Start the job');
    startJob(env, earlier.id);
    await env.runOnce(env.worker('w1', { toolList: withJobTools(env) }));
    expect(env.run(earlier.id).status).toBe('COMPLETED');
    env.gateway.script.push(textStep('second done'));
    const later = env.enqueue('Look at the job');

    await env.runOnce(env.worker('w2', { toolList: withJobTools(env) }));

    expect(env.run(later.id).status).toBe('COMPLETED');
    expect(namesOf(env, 1)).not.toContain('Bash');
    expect(namesOf(env, 1).filter((name) => JOB_TOOLS.includes(name))).toEqual(JOB_TOOLS);
  });

  it('stops offering both job tools once the job has ended, also after recovery by another worker', async () => {
    const env = await makeEnv();
    env.settings.extraRules.push({ effect: 'deny', rule: 'Bash' });
    const first = path.join(env.project, 'first.txt');
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: first, content: 'one' } }]));
    const run = env.enqueue('Write a file');
    const jobId = startJob(env, run.id);
    await env.runOnce(env.worker('w1', { toolList: withJobTools(env) }));
    env.store.jobs.finish(jobId, { status: 'exited', exitCode: 0 });
    await env.resolveApproval(run.id, 'allow_once');
    env.gateway.script.push(textStep('Written.'));

    await env.runOnce(env.worker('w2', { toolList: withJobTools(env) }));

    expect(namesOf(env, 0).filter((name) => JOB_TOOLS.includes(name))).toEqual(JOB_TOOLS);
    expect(namesOf(env, 1).filter((name) => JOB_TOOLS.includes(name))).toEqual([]);
  });
});
