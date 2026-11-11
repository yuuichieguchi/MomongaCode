import { describe, expect, it } from 'vitest';
import { MAX_JSON_DEPTH } from '@momonga/foundation';
import type { FunctionCallItem } from '@momonga/protocol';
import { defineTool } from '@momonga/tools';
import type { AnyTool } from '@momonga/tools';
import { makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { outputStep, textStep } from './scripts.ts';

const STACK_BREAKING_DEPTH = 3000;

const nestedArraysText = (depth: number): string => `${'['.repeat(depth)}${']'.repeat(depth)}`;

const treeArguments = (depth: number): string => `{"tree":${nestedArraysText(depth - 1)}}`;

const treeCall = (depth: number): FunctionCallItem => ({
  type: 'function_call',
  id: 'fc_tree',
  call_id: 'call_tree',
  name: 'Tree',
  arguments: treeArguments(depth),
  status: 'completed',
});

const treeTool = (received: unknown[]): AnyTool =>
  defineTool<Record<string, unknown>>({
    name: 'Tree',
    description: 'Accepts any JSON tree.',
    kind: 'read',
    sideEffect: 'read_only',
    inputSchema: { type: 'object', properties: { tree: { type: 'array' } }, required: ['tree'], additionalProperties: false },
    timeoutMs: 1_000,
    title: () => 'Tree',
    subject: () => ({ kind: 'none', tool: 'Tree' }),
    execute: async (input) => {
      received.push(input['tree']);
      return { status: 'completed', output: 'tree:ok' };
    },
  });

const runTreeCall = async (depth: number): Promise<{ env: Env; runId: string; received: unknown[] }> => {
  const env = await makeEnv();
  const received: unknown[] = [];
  env.gateway.script.push(outputStep([treeCall(depth)]), textStep('Done.'));
  const run = await env.enqueue('Send a tree');
  await env.runOnce(env.worker('w1', { toolList: () => [...env.toolbox.tools(), treeTool(received)] }));
  return { env, runId: run.id, received };
};

describe('tool call arguments and the one JSON depth bound', () => {
  it('counts the nesting of the generated arguments as the depth under test', () => {
    expect(JSON.stringify(JSON.parse(treeArguments(3)))).toBe('{"tree":[[]]}');
  });

  it(`executes a call whose arguments nest exactly ${MAX_JSON_DEPTH} deep`, async () => {
    const { env, runId, received } = await runTreeCall(MAX_JSON_DEPTH);
    expect(env.run(runId).status).toBe('COMPLETED');
    expect(received).toHaveLength(1);
    expect(env.ofType(runId, 'tool.completed').map((event) => event.output)).toEqual(['tree:ok']);
  });

  it.each([MAX_JSON_DEPTH + 1, STACK_BREAKING_DEPTH])(
    'returns an invalid-arguments result naming the depth for a call %i deep, and the run continues to its next step',
    async (depth) => {
      const { env, runId, received } = await runTreeCall(depth);
      const run = env.run(runId);
      expect(received).toEqual([]);
      expect(run.attempts).toBe(1);
      expect(run.status).toBe('COMPLETED');
      const notices = env.ofType(runId, 'notice');
      expect(notices.filter((notice) => notice.code === 'attempt_retried')).toEqual([]);
      const outputs = env.ofType(runId, 'tool.completed').map((event) => event.output);
      expect(outputs).toHaveLength(1);
      expect(outputs[0]).toMatch(/invalid/i);
      expect(outputs[0]).toContain('Tree');
      expect(outputs[0]).toMatch(/depth/i);
      expect(outputs[0]).toContain(String(MAX_JSON_DEPTH));
      expect(outputs[0]).not.toMatch(/Maximum call stack size exceeded/);
      expect(env.gateway.script).toEqual([]);
    },
  );
});
