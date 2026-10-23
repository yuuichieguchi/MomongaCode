import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AnyTool, ToolResult } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { deferred, flush, until } from './helpers.ts';
import type { Deferred } from './helpers.ts';

const controllable = (name: string, sideEffect: 'read_only' | 'write' | 'exec' = 'read_only') => {
  const gates = new Map<string, Deferred<ToolResult>>();
  const startedIds: string[] = [];
  let active = 0;
  let maxActive = 0;
  const tool: AnyTool = makeTool(name, {
    sideEffect,
    kind: sideEffect === 'read_only' ? 'read' : sideEffect === 'write' ? 'edit' : 'execute',
    execute: async (_input, ctx) => {
      const gate = deferred<ToolResult>();
      gates.set(ctx.callId, gate);
      startedIds.push(ctx.callId);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        return await gate.promise;
      } finally {
        active -= 1;
      }
    },
  });
  const finish = (callId: string): void => {
    const gate = gates.get(callId);
    if (gate === undefined) throw new Error(`${callId} has not started`);
    gate.resolve({ status: 'completed', output: `${callId} done` });
  };
  return { tool, startedIds, finish, maxActive: () => maxActive };
};

const instant = (name: string, sideEffect: 'read_only' | 'write' | 'exec', log: string[]) =>
  makeTool(name, {
    sideEffect,
    kind: sideEffect === 'read_only' ? 'read' : 'edit',
    execute: async (_input, ctx) => {
      log.push(ctx.callId);
      return { status: 'completed', output: `${ctx.callId} done` };
    },
  });

describe('batch scheduling', () => {
  it('runs consecutive read-only calls concurrently and returns outcomes in call order', async () => {
    const harness = makeHarness();
    const reader = controllable('Read');
    const pending = harness.executor.runBatch(harness.input(await toolSetOf(reader.tool), [call('r1', 'Read'), call('r2', 'Read'), call('r3', 'Read')]));
    await until(() => reader.startedIds.length === 3);
    reader.finish('r3');
    reader.finish('r1');
    reader.finish('r2');
    const outcomes = await pending;
    expect(outcomes.map((outcome) => outcome.callId)).toEqual(['r1', 'r2', 'r3']);
    expect(outcomes.map((outcome) => (outcome.kind === 'result' ? outcome.result.output : outcome.kind))).toEqual(['r1 done', 'r2 done', 'r3 done']);
  });

  it('respects maxParallel for read-only groups', async () => {
    const harness = makeHarness({ maxParallel: 2 });
    const reader = controllable('Read');
    const calls = ['r1', 'r2', 'r3', 'r4'].map((id) => call(id, 'Read'));
    const pending = harness.executor.runBatch(harness.input(await toolSetOf(reader.tool), calls));
    await until(() => reader.startedIds.length === 2);
    await flush();
    expect(reader.startedIds).toHaveLength(2);
    reader.finish(reader.startedIds[0] as string);
    await until(() => reader.startedIds.length === 3);
    await flush();
    expect(reader.startedIds).toHaveLength(3);
    for (const id of reader.startedIds.slice(1)) reader.finish(id);
    await until(() => reader.startedIds.length === 4);
    reader.finish(reader.startedIds[3] as string);
    await pending;
    expect(reader.maxActive()).toBe(2);
  });

  it('runs write and exec calls one at a time in order', async () => {
    const harness = makeHarness();
    const writer = controllable('Write', 'write');
    const pending = harness.executor.runBatch(harness.input(await toolSetOf(writer.tool), [call('w1', 'Write'), call('w2', 'Write'), call('w3', 'Write')]));
    await until(() => writer.startedIds.length === 1);
    await flush();
    expect(writer.startedIds).toEqual(['w1']);
    writer.finish('w1');
    await until(() => writer.startedIds.length === 2);
    await flush();
    expect(writer.startedIds).toEqual(['w1', 'w2']);
    writer.finish('w2');
    await until(() => writer.startedIds.length === 3);
    writer.finish('w3');
    await pending;
    expect(writer.maxActive()).toBe(1);
  });

  it('does not start a write before preceding reads finish nor later reads before the write finishes', async () => {
    const harness = makeHarness();
    const reader = controllable('Read');
    const writer = controllable('Write', 'write');
    const set = await toolSetOf(reader.tool, writer.tool);
    const pending = harness.executor.runBatch(harness.input(set, [call('r1', 'Read'), call('r2', 'Read'), call('w3', 'Write'), call('r4', 'Read')]));
    await until(() => reader.startedIds.length === 2);
    await flush();
    expect(writer.startedIds).toEqual([]);
    reader.finish('r1');
    await flush();
    expect(writer.startedIds).toEqual([]);
    reader.finish('r2');
    await until(() => writer.startedIds.length === 1);
    await flush();
    expect(reader.startedIds).toEqual(['r1', 'r2']);
    writer.finish('w3');
    await until(() => reader.startedIds.length === 3);
    reader.finish('r4');
    const outcomes = await pending;
    expect(outcomes.map((outcome) => outcome.callId)).toEqual(['r1', 'r2', 'w3', 'r4']);
  });

  it('stops at the first approval request and defers later calls without validating them', async () => {
    const harness = makeHarness();
    const log: string[] = [];
    const bash = makeTool('Bash', {
      sideEffect: 'exec',
      kind: 'execute',
      subject: () => ({ kind: 'command', tool: 'Bash', command: 'make build' }),
      execute: async () => {
        log.push('bash');
        return { status: 'completed', output: 'built' };
      },
    });
    const set = await toolSetOf(instant('Read', 'read_only', log), instant('Write', 'write', log), bash);
    const outcomes = await harness.executor.runBatch(
      harness.input(set, [
        call('c1', 'Write'),
        call('c2', 'Bash'),
        call('c3', 'Nope'),
        call('c4', 'Read', { unexpected: true }),
        call('c5', 'Read'),
      ]),
    );
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['result', 'needs_approval', 'deferred', 'deferred', 'deferred']);
    expect(outcomes.slice(2)).toEqual([
      { callId: 'c3', kind: 'deferred' },
      { callId: 'c4', kind: 'deferred' },
      { callId: 'c5', kind: 'deferred' },
    ]);
    expect(log).toEqual(['c1']);
  });

  it('completes read-only peers before an asking read-only call and defers the rest of the group', async () => {
    const harness = makeHarness();
    const log: string[] = [];
    const reader = makeTool('Read', {
      inputSchema: { type: 'object', properties: { where: { type: 'string' } }, additionalProperties: false },
      subject: (input) => ({ kind: 'path', tool: 'Read', paths: [String(input['where'])], access: 'read' }),
      execute: async (_input, ctx) => {
        log.push(ctx.callId);
        return { status: 'completed', output: `${ctx.callId} read` };
      },
    });
    const inside = path.join(harness.layout.project, 'a.txt');
    const outside = path.join(harness.layout.outside, 'b.txt');
    fs.writeFileSync(inside, 'a');
    fs.writeFileSync(outside, 'b');
    const outcomes = await harness.executor.runBatch(
      harness.input(await toolSetOf(reader), [call('r1', 'Read', { where: inside }), call('r2', 'Read', { where: outside }), call('r3', 'Read', { where: inside })]),
    );
    expect(outcomes[0]).toMatchObject({ callId: 'r1', kind: 'result', result: { status: 'completed', output: 'r1 read' } });
    expect(outcomes[1]).toMatchObject({ callId: 'r2', kind: 'needs_approval' });
    expect(outcomes[2]).toEqual({ callId: 'r3', kind: 'deferred' });
    expect(log).toEqual(['r1']);
  });

  it('resumes after approval without re-running or re-asking completed calls', async () => {
    const harness = makeHarness();
    const log: string[] = [];
    const bash = makeTool('Bash', {
      sideEffect: 'exec',
      kind: 'execute',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false },
      subject: (input) => ({ kind: 'command', tool: 'Bash', command: String(input['command']) }),
      execute: async (_input, ctx) => {
        log.push(ctx.callId);
        return { status: 'completed', output: `${ctx.callId} ran` };
      },
    });
    const set = await toolSetOf(instant('Read', 'read_only', log), bash);
    const first = await harness.executor.runBatch(
      harness.input(set, [call('c1', 'Bash', { command: 'make one' }, 'allow_once'), call('c2', 'Read'), call('c3', 'Bash', { command: 'make two' }), call('c4', 'Read')]),
    );
    expect(first.map((outcome) => outcome.kind)).toEqual(['result', 'result', 'needs_approval', 'deferred']);
    expect(log).toEqual(['c1', 'c2']);
    expect(harness.started).toEqual(['c1', 'c2']);
    const second = await harness.executor.runBatch(
      harness.input(set, [call('c1', 'Bash', { command: 'make one' }), call('c2', 'Read'), call('c3', 'Bash', { command: 'make two' }, 'allow_once'), call('c4', 'Read')]),
    );
    expect(second[0]).toEqual(first[0]);
    expect(second[1]).toEqual(first[1]);
    expect(second[2]).toMatchObject({ callId: 'c3', kind: 'result', result: { status: 'completed', output: 'c3 ran' } });
    expect(second[3]).toMatchObject({ callId: 'c4', kind: 'result', result: { status: 'completed', output: 'c4 done' } });
    expect(log).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(harness.started).toEqual(['c1', 'c2', 'c3', 'c4']);
  });

  it('decides each call against session.cwd at the moment it is decided', async () => {
    const harness = makeHarness();
    const subDir = path.join(harness.layout.project, 'sub');
    fs.mkdirSync(subDir);
    const seenCwd: string[] = [];
    const mover = makeTool('Bash', {
      sideEffect: 'exec',
      kind: 'execute',
      execute: async (_input, ctx) => {
        ctx.session.cwd = subDir;
        return { status: 'completed', output: 'moved' };
      },
    });
    const reader = makeTool('Read', {
      subject: (_input, ctx) => {
        seenCwd.push(ctx.cwd);
        return { kind: 'none', tool: 'Read' };
      },
    });
    await harness.executor.runBatch(harness.input(await toolSetOf(mover, reader), [call('c1', 'Read'), call('c2', 'Bash'), call('c3', 'Read')]));
    expect(seenCwd).toEqual([harness.layout.project, subDir]);
    expect(harness.session.cwd).toBe(subDir);
  });
});
