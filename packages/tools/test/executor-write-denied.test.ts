import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { minimalPolicyFor } from './helpers.ts';

const pathTool = (access: 'read' | 'write', target: string, runs: string[]) =>
  makeTool('PathTool', {
    kind: access === 'read' ? 'read' : 'edit',
    sideEffect: access === 'read' ? 'read_only' : 'write',
    subject: () => ({ kind: 'path', tool: 'PathTool', paths: [target], access }),
    execute: async () => {
      runs.push(target);
      return { status: 'completed', output: 'touched' };
    },
  });

describe('executor: writeDenied path subjects', () => {
  it('denies a write inside a writeDenied entry even in bypassPermissions with approval', async () => {
    const harness = makeHarness();
    const sessions = path.join(harness.layout.project, 'sessions');
    fs.mkdirSync(path.join(sessions, 'other'), { recursive: true });
    const target = path.join(sessions, 'other', 'f');
    const runs: string[] = [];
    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSetOf(pathTool('write', target, runs)), [call('c1', 'PathTool', {}, 'allow_once')], {
        mode: 'bypassPermissions',
        sandboxPolicy: { ...minimalPolicyFor({ layout: harness.layout }), writeDenied: [sessions] },
      }),
    );
    expect(outcome).toMatchObject({ callId: 'c1', kind: 'result', result: { status: 'failed' } });
    expect((outcome as { result: { output: string } }).result.output).toMatch(/^Permission denied: /);
    expect(runs).toEqual([]);
  });

  it('denies a write that reaches a writeDenied entry through a symlink', async () => {
    const harness = makeHarness();
    const keychains = path.join(harness.layout.home, 'Library', 'Keychains');
    fs.mkdirSync(keychains, { recursive: true });
    const link = path.join(harness.layout.project, 'innocent');
    fs.symlinkSync(keychains, link);
    const runs: string[] = [];
    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSetOf(pathTool('write', path.join(link, 'x'), runs)), [call('c1', 'PathTool', {}, 'allow_once')], {
        mode: 'bypassPermissions',
        sandboxPolicy: { ...minimalPolicyFor({ layout: harness.layout }), writeDenied: [keychains] },
      }),
    );
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'failed' } });
    expect((outcome as { result: { output: string } }).result.output).toMatch(/^Permission denied: /);
    expect(runs).toEqual([]);
  });

  it('still lets a read inside a writeDenied entry run', async () => {
    const harness = makeHarness();
    const sessions = path.join(harness.layout.project, 'sessions');
    fs.mkdirSync(sessions);
    const target = path.join(sessions, 'f');
    const runs: string[] = [];
    const [outcome] = await harness.executor.runBatch(
      harness.input(await toolSetOf(pathTool('read', target, runs)), [call('c1', 'PathTool')], {
        mode: 'bypassPermissions',
        sandboxPolicy: { ...minimalPolicyFor({ layout: harness.layout }), writeDenied: [sessions] },
      }),
    );
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed' } });
    expect(runs).toEqual([target]);
  });
});
