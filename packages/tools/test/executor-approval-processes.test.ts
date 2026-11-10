import { spawn } from '@momonga/testkit/child-process';
import { once } from 'node:events';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PermissionSubject } from '@momonga/policy';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { ruleFor } from './helpers.ts';

const PATH_SCHEMA = { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'], additionalProperties: false } as const;

const writeSubject = (input: Record<string, unknown>): Extract<PermissionSubject, { kind: 'path' }> => ({ kind: 'path', tool: 'Write', paths: [String(input['file_path'])], access: 'write' });

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
};

const processTool = (name: string, pids: number[]) =>
  makeTool(name, {
    execute: async () => {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 200)'], { stdio: 'ignore' });
      if (child.pid === undefined) throw new Error('the child process did not start');
      pids.push(child.pid);
      await once(child, 'exit');
      return { status: 'completed', output: `${name} done` };
    },
  });

describe('a batch that stops for an approval leaves no tool process running', () => {
  it('lets a concurrent read-only call that started a process finish before it returns needs_approval', async () => {
    const harness = makeHarness();
    const pids: number[] = [];
    const rule = ruleFor(harness.layout);

    const outcomes = await harness.executor.runBatch(
      harness.input(await toolSetOf(processTool('Probe', pids), makeTool('UpdatePlan')), [call('cP', 'Probe'), call('cA', 'UpdatePlan')], {
        mode: 'manual',
        rules: [rule('ask', 'UpdatePlan')],
      }),
    );

    expect(outcomes.map((outcome) => [outcome.callId, outcome.kind])).toEqual([
      ['cP', 'result'],
      ['cA', 'needs_approval'],
    ]);
    expect(pids).toHaveLength(1);
    expect(pids.filter(alive)).toEqual([]);
  });

  it('finishes the process of an earlier call before it asks for a later Write, and starts no process after the ask', async () => {
    const harness = makeHarness();
    const pids: number[] = [];
    const write = makeTool('Write', { kind: 'edit', sideEffect: 'write', subjectKind: 'path', inputSchema: PATH_SCHEMA, subject: writeSubject });

    const outcomes = await harness.executor.runBatch(
      harness.input(
        await toolSetOf(processTool('Probe', pids), processTool('Later', pids), write),
        [call('cP', 'Probe'), call('cW', 'Write', { file_path: path.join(harness.layout.outside, 'w.txt') }), call('cL', 'Later')],
        { mode: 'manual' },
      ),
    );

    expect(outcomes.map((outcome) => [outcome.callId, outcome.kind])).toEqual([
      ['cP', 'result'],
      ['cW', 'needs_approval'],
      ['cL', 'deferred'],
    ]);
    expect(pids).toHaveLength(1);
    expect(pids.filter(alive)).toEqual([]);
  });
});
