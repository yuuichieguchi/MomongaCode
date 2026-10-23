import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';

describe('path subject digest fails closed', () => {
  it('fails a path call that needs approval when its target cannot be resolved to a real location', async () => {
    const harness = makeHarness();
    const locked = path.join(harness.layout.project, 'locked');
    const target = path.join(locked, 'inner', 'file.txt');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const runs: string[] = [];
    const tool = makeTool('PathTool', {
      subject: () => ({ kind: 'path', tool: 'PathTool', paths: [target], access: 'read' }),
      execute: async () => {
        runs.push('ran');
        return { status: 'completed', output: 'read' };
      },
    });
    const toolSet = await toolSetOf(tool);
    fs.chmodSync(locked, 0o000);
    try {
      const outcomes = await harness.executor.runBatch(harness.input(toolSet, [call('p1', 'PathTool')]));
      expect(outcomes).toEqual([
        {
          callId: 'p1',
          kind: 'result',
          result: { status: 'failed', output: `Permission check failed: ${target} cannot be resolved to a real location` },
        },
      ]);
      expect(runs).toEqual([]);
      expect(harness.idempotency.records.size).toBe(0);
      expect(harness.started).toEqual([]);
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });

  it('does not let an approval bound to the raw path authorize an unresolvable target', async () => {
    const harness = makeHarness();
    const locked = path.join(harness.layout.project, 'locked');
    const target = path.join(locked, 'inner', 'file.txt');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const runs: string[] = [];
    const tool = makeTool('PathTool', {
      subject: () => ({ kind: 'path', tool: 'PathTool', paths: [target], access: 'read' }),
      execute: async () => {
        runs.push('ran');
        return { status: 'completed', output: 'read' };
      },
    });
    const toolSet = await toolSetOf(tool);
    fs.chmodSync(locked, 0o000);
    try {
      const [outcome] = await harness.executor.runBatch(harness.input(toolSet, [call('p1', 'PathTool', {}, 'allow_once')]));
      expect(outcome).toMatchObject({ kind: 'result', result: { status: 'failed' } });
      expect(runs).toEqual([]);
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });
});
