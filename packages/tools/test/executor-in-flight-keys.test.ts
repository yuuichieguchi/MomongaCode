import { describe, expect, it } from 'vitest';
import { ToolExecutionError } from '@momonga/tools';
import type { ToolContext, ToolResult } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { waitFor } from '@momonga/testkit';
import { keyFor } from './helpers.ts';

const KEY = keyFor('run-1', 1, 'c1');

type Gate = { opened: Promise<void>; open(): void };

const gate = (): Gate => {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
};

const execTool = (execute: (ctx: ToolContext) => Promise<ToolResult>) =>
  makeTool('Bash', {
    kind: 'execute',
    sideEffect: 'exec',
    execute: async (_input, ctx) => execute(ctx),
  });

describe('executor: begin stores runId in meta (§8)', () => {
  it('the PENDING record written by begin has meta { tool, runId }', async () => {
    const harness = makeHarness();
    const seenMeta: unknown[] = [];
    const tool = execTool(async () => {
      const lookup = harness.idempotency.port.get(KEY);
      if (lookup?.s === 'PENDING') seenMeta.push(lookup.rec.meta);
      return { status: 'completed', output: 'ran' };
    });
    await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Bash')]));
    expect(seenMeta).toEqual([{ tool: 'Bash', runId: 'run-1' }]);
  });

  it('runId in meta comes from the batch, not from a constant', async () => {
    const harness = makeHarness();
    const tool = execTool(async () => ({ status: 'completed', output: 'ran' }));
    await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Bash')], { runId: 'run-other' }));
    const begin = harness.idempotency.log.find((entry) => entry.op === 'begin');
    expect(begin).toMatchObject({ op: 'begin', key: keyFor('run-other', 1, 'c1'), meta: { tool: 'Bash', runId: 'run-other' } });
  });
});

describe('executor: inFlightKeys (§8)', () => {
  it('the key is in the set while the tool runs and absent after success', async () => {
    const harness = makeHarness();
    const running = gate();
    const release = gate();
    const tool = execTool(async () => {
      running.open();
      await release.opened;
      return { status: 'completed', output: 'ran' };
    });
    expect([...harness.executor.inFlightKeys()]).toEqual([]);
    const batch = harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Bash')]));
    await running.opened;
    expect([...harness.executor.inFlightKeys()]).toEqual([KEY]);
    release.open();
    await batch;
    expect([...harness.executor.inFlightKeys()]).toEqual([]);
  });

  it('the key is absent after a failed execution', async () => {
    const harness = makeHarness();
    const running = gate();
    const release = gate();
    const tool = execTool(async () => {
      running.open();
      await release.opened;
      throw new ToolExecutionError('exit 1');
    });
    const batch = harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Bash')]));
    await running.opened;
    expect(harness.executor.inFlightKeys().has(KEY)).toBe(true);
    release.open();
    const [outcome] = await batch;
    expect(outcome).toMatchObject({ result: { status: 'failed' } });
    expect(harness.executor.inFlightKeys().has(KEY)).toBe(false);
  });

  it('the key is absent after the batch is aborted', async () => {
    const harness = makeHarness();
    const running = gate();
    const tool = execTool(async (ctx) => {
      running.open();
      await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { status: 'completed', output: 'stopped' };
    });
    const controller = new AbortController();
    const batch = harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Bash')], { signal: controller.signal }));
    await running.opened;
    expect(harness.executor.inFlightKeys().has(KEY)).toBe(true);
    controller.abort();
    await batch;
    expect(harness.executor.inFlightKeys().has(KEY)).toBe(false);
  });

  it('inFlightKeys returns a snapshot that later calls do not mutate', async () => {
    const harness = makeHarness();
    const running = gate();
    const release = gate();
    const tool = execTool(async () => {
      running.open();
      await release.opened;
      return { status: 'completed', output: 'ran' };
    });
    const batch = harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Bash')]));
    await running.opened;
    const snapshot = harness.executor.inFlightKeys();
    release.open();
    await batch;
    expect([...snapshot]).toEqual([KEY]);
    expect(harness.executor.inFlightKeys().size).toBe(0);
  });

  it('counts overlapping performs of one key: the key stays until the last perform finishes', async () => {
    const harness = makeHarness();
    const zombieRunning = gate();
    const zombieRelease = gate();
    const reconcileStarted = gate();
    const reconcileRelease = gate();
    let zombieLeaseLost = false;
    const tool = makeTool('Edit', {
      kind: 'edit',
      sideEffect: 'write',
      execute: async () => {
        zombieRunning.open();
        await zombieRelease.opened;
        return { status: 'completed', output: 'zombie finished' };
      },
      reconcile: async () => {
        reconcileStarted.open();
        await reconcileRelease.opened;
        return { outcome: 'already_applied', output: 'reconciled' };
      },
    });
    const toolSet = await toolSetOf(tool);
    const zombie = harness.executor.runBatch(harness.input(toolSet, [call('c1', 'Edit', {}, 'allow_once')], { leaseLost: () => zombieLeaseLost }));
    await zombieRunning.opened;
    expect(harness.idempotency.stateOf(KEY)).toBe('PENDING');

    const replay = harness.executor.runBatch(harness.input(toolSet, [call('c1', 'Edit', {}, 'allow_once')]));
    expect(harness.executor.inFlightKeys().has(KEY)).toBe(true);

    zombieLeaseLost = true;
    zombieRelease.open();
    const [deferred] = await zombie;
    expect(deferred).toMatchObject({ kind: 'deferred' });

    await reconcileStarted.opened;
    expect(harness.executor.inFlightKeys().has(KEY)).toBe(true);
    reconcileRelease.open();
    const [replayed] = await replay;
    expect(replayed).toMatchObject({ kind: 'result', reconciled: 'already_applied' });
    await waitFor(() => !harness.executor.inFlightKeys().has(KEY), { description: 'the replay perform to drop its count' });
    expect(harness.executor.inFlightKeys().size).toBe(0);
  });
});
