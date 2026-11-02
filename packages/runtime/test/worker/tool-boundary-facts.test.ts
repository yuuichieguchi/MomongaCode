import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@momonga/foundation';
import { defineTool } from '@momonga/tools';
import type { AnyTool } from '@momonga/tools';
import { makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const WRITTEN = '/proj/fact.txt';

const factTools = (): AnyTool[] => [
  defineTool<{ content: string }>({
    name: 'Write',
    description: 'Reports the file it wrote as a structured fact',
    kind: 'edit',
    sideEffect: 'write',
    inputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false },
    timeoutMs: 1000,
    title: () => 'Write',
    subject: () => ({ kind: 'path', tool: 'Write', paths: [WRITTEN], access: 'write' }),
    execute: async (input) => ({ status: 'completed', output: 'written', files: [{ path: WRITTEN, sha256: sha256Hex(input.content), access: 'write' }] }),
  }),
  defineTool<{ command: string }>({
    name: 'Bash',
    description: 'Reports the exit code it saw as a structured fact',
    kind: 'execute',
    sideEffect: 'exec',
    inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false },
    timeoutMs: 1000,
    title: () => 'Bash',
    subject: (input) => ({ kind: 'command', tool: 'Bash', command: input.command }),
    execute: async () => ({ status: 'failed', output: 'boom', exitCode: 3 }),
  }),
];

describe('structured facts set at the tool boundary', () => {
  it('journals the files a tool reports, and the fold keeps a written file as a working fact', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { content: 'hello' } }]), textStep('Done.'));
    const run = env.enqueue();

    await env.runOnce(env.worker('worker-1', { toolList: factTools }));

    const [completed] = env.ofType(run.id, 'tool.completed');
    expect(completed?.files).toEqual([{ path: WRITTEN, sha256: sha256Hex('hello'), access: 'write' }]);
    expect(completed?.exitCode).toBeUndefined();
    expect(env.fold(run.id).workingFacts.written).toEqual([{ path: WRITTEN, sha256: sha256Hex('hello'), seq: completed?.seq }]);
  });

  it('journals the exit code a tool reports, and the fold keeps a failed command as a working fact', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.gateway.script.push(callsStep([{ callId: 'call_b_1', name: 'Bash', args: { command: 'make lint' } }]), textStep('Done.'));
    const run = env.enqueue();

    await env.runOnce(env.worker('worker-1', { toolList: factTools }));

    const [completed] = env.ofType(run.id, 'tool.completed');
    expect(completed).toMatchObject({ status: 'failed', exitCode: 3 });
    expect(completed?.files).toBeUndefined();
    expect(env.fold(run.id).workingFacts.commands).toEqual([{ command: 'make lint', failed: true, exitCode: 3, seq: completed?.seq }]);
  });
});
