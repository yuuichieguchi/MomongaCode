import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolExecutionError } from '@momonga/tools';
import type { ToolContext } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { keyFor } from './helpers.ts';

const KEY = keyFor('run-1', 1, 'c1');

type Seen = { marker: string | undefined; exists: boolean; mode: number | undefined };

const observe = (ctx: ToolContext): Seen => {
  const marker = ctx.processMarker;
  const exists = marker !== undefined && fs.existsSync(marker);
  return { marker, exists, mode: exists && marker !== undefined ? fs.statSync(marker).mode & 0o777 : undefined };
};

const execTool = (seen: Seen[], behavior: (ctx: ToolContext) => Promise<{ status: 'completed'; output: string }> = async () => ({ status: 'completed', output: 'ran' })) =>
  makeTool('Bash', {
    kind: 'execute',
    sideEffect: 'exec',
    execute: async (_input, ctx) => {
      seen.push(observe(ctx));
      return behavior(ctx);
    },
  });

describe('process marker', () => {
  it('creates an empty 0600 marker named after the key for exec tools and removes it after completion', async () => {
    const harness = makeHarness();
    const seen: Seen[] = [];
    await harness.executor.runBatch(harness.input(await toolSetOf(execTool(seen)), [call('c1', 'Bash')]));
    const expected = path.join(harness.markerDir, KEY);
    expect(seen).toEqual([{ marker: expected, exists: true, mode: 0o600 }]);
    expect(fs.existsSync(expected)).toBe(false);
    expect(fs.readdirSync(harness.markerDir)).toEqual([]);
  });

  it('removes the marker after a failed execution', async () => {
    const harness = makeHarness();
    const seen: Seen[] = [];
    const tool = execTool(seen, async () => {
      throw new ToolExecutionError('exit 1');
    });
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Bash')]));
    expect(outcome).toMatchObject({ result: { status: 'failed', output: 'exit 1' } });
    expect(seen[0]?.exists).toBe(true);
    expect(fs.readdirSync(harness.markerDir)).toEqual([]);
  });

  it('removes the marker after a timeout', async () => {
    const harness = makeHarness();
    const seen: Seen[] = [];
    const tool = makeTool('Bash', {
      kind: 'execute',
      sideEffect: 'exec',
      timeoutMs: 30,
      execute: (_input, ctx) => {
        seen.push(observe(ctx));
        return new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve({ status: 'failed', output: 'aborted' }), { once: true }));
      },
    });
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Bash')]));
    expect(outcome).toMatchObject({ result: { status: 'failed' } });
    expect(seen[0]?.exists).toBe(true);
    expect(fs.readdirSync(harness.markerDir)).toEqual([]);
  });

  it('passes the marker to reconcile and removes it after the reconciled record completes', async () => {
    const harness = makeHarness();
    const marker = path.join(harness.markerDir, KEY);
    fs.writeFileSync(marker, '', { mode: 0o600 });
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Bash' });
    const reconcileMarkers: Array<string | undefined> = [];
    let executions = 0;
    const tool = makeTool('Bash', {
      kind: 'execute',
      sideEffect: 'exec',
      execute: async () => {
        executions += 1;
        return { status: 'completed', output: 'ran' };
      },
      reconcile: async (_input, _record, ctx) => {
        reconcileMarkers.push(ctx.processMarker);
        return { outcome: 'unknown', output: 'stopped the interrupted command' };
      },
    });
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Bash')]));
    expect(outcome).toMatchObject({ reconciled: 'unknown' });
    expect(reconcileMarkers).toEqual([marker]);
    expect(executions).toBe(0);
    expect(harness.idempotency.stateOf(KEY)).toBe('COMPLETED');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it.each([
    ['read_only', 'read'],
    ['write', 'edit'],
  ] as const)('gives %s tools no marker', async (sideEffect, kind) => {
    const harness = makeHarness();
    const seen: Array<string | undefined> = [];
    const tool = makeTool('Tool', {
      kind,
      sideEffect,
      execute: async (_input, ctx) => {
        seen.push(ctx.processMarker);
        return { status: 'completed', output: 'ok' };
      },
    });
    await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Tool')]));
    expect(seen).toEqual([undefined]);
    expect(fs.readdirSync(harness.markerDir)).toEqual([]);
  });
});
