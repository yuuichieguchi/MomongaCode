import { describe, expect, it } from 'vitest';
import { ToolInputRequired } from '@momonga/tools';
import type { ToolResume } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { keyFor } from './helpers.ts';

const REQUESTS = [{ key: 'who', mode: 'form' as const, message: 'Who?', requestedSchema: { type: 'object' } }];
const WRITE = { sideEffect: 'write' as const, subjectKind: 'none' as const, kind: 'other' as const };

describe('tools that wait for a person', () => {
  it('reports needs_input, keeps the record pending and stores the checkpoint', async () => {
    const harness = makeHarness();
    const tool = makeTool('Ask', {
      ...WRITE,
      execute: async () => {
        throw new ToolInputRequired({ server: 'remote', requests: REQUESTS, checkpoint: { kind: 'mrtr', rounds: 1, requestState: 's' } });
      },
    });
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Ask', {}, 'allow_once')]));
    expect(outcome).toEqual({ callId: 'c1', kind: 'needs_input', server: 'remote', requests: REQUESTS });
    const lookup = harness.idempotency.port.get(keyFor('run-1', 1, 'c1'));
    expect(lookup).toMatchObject({ s: 'PENDING', rec: { meta: { checkpoint: { kind: 'mrtr', rounds: 1, requestState: 's' } } } });
  });

  it('resumes the same call with its checkpoint and the answers instead of reconciling it', async () => {
    const harness = makeHarness();
    const seen: Array<ToolResume | undefined> = [];
    let first = true;
    const tool = makeTool('Ask', {
      ...WRITE,
      execute: async (_input, ctx) => {
        seen.push(ctx.resume);
        if (first) {
          first = false;
          throw new ToolInputRequired({ server: 'remote', requests: REQUESTS, checkpoint: { kind: 'mrtr', rounds: 1 } });
        }
        return { status: 'completed', output: 'hello Ada' };
      },
    });
    const toolSet = await toolSetOf(tool);
    await harness.executor.runBatch(harness.input(toolSet, [call('c1', 'Ask', {}, 'allow_once')]));
    const responses = { who: { action: 'accept', content: { name: 'Ada' } } };
    const [outcome] = await harness.executor.runBatch(
      harness.input(toolSet, [{ ...call('c1', 'Ask', {}, 'allow_once'), inputResponses: responses }]),
    );
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed', output: 'hello Ada' } });
    expect(outcome).not.toHaveProperty('reconciled');
    expect(seen).toEqual([undefined, { checkpoint: { kind: 'mrtr', rounds: 1 }, inputResponses: responses }]);
  });

  it('resumes a recorded checkpoint without answers, as after a crash mid-task', async () => {
    const harness = makeHarness();
    const seen: Array<ToolResume | undefined> = [];
    const tool = makeTool('Poll', {
      ...WRITE,
      execute: async (_input, ctx) => {
        seen.push(ctx.resume);
        return { status: 'completed', output: 'task done' };
      },
    });
    harness.idempotency.seed(keyFor('run-1', 1, 'c1'), 'PENDING', { tool: 'Poll', checkpoint: { kind: 'task', taskId: 't1', answered: [] } });
    const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Poll', {}, 'allow_once')]));
    expect(outcome).toMatchObject({ kind: 'result', result: { output: 'task done' } });
    expect(seen).toEqual([{ checkpoint: { kind: 'task', taskId: 't1', answered: [] }, inputResponses: undefined }]);
  });

  it('lets a tool record and clear its own checkpoint', async () => {
    const harness = makeHarness();
    const tool = makeTool('Poll', {
      ...WRITE,
      execute: async (_input, ctx) => {
        ctx.checkpoint({ kind: 'task', taskId: 't1', answered: [] });
        ctx.checkpoint(undefined);
        return { status: 'completed', output: 'ok' };
      },
    });
    await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Poll', {}, 'allow_once')]));
    expect(harness.idempotency.log.filter((entry) => entry.op === 'checkpoint').map((entry) => entry.op === 'checkpoint' && entry.state)).toEqual([
      { kind: 'task', taskId: 't1', answered: [] },
      undefined,
    ]);
  });

  describe('releasing a call that waits for a person', () => {
    const KEY = keyFor('run-1', 1, 'c1');
    const TASK = { kind: 'task', taskId: 't1', answered: [] };
    const target = { callId: 'c1', name: 'Poll', idemKey: KEY };
    const noSignal = (): AbortSignal => new AbortController().signal;

    it('hands the checkpoint to the tool, clears it and marks the record unknown', async () => {
      const harness = makeHarness();
      const released: Array<Record<string, unknown>> = [];
      const tool = makeTool('Poll', {
        ...WRITE,
        releaseCheckpoint: async (checkpoint) => {
          released.push(checkpoint);
        },
      });
      harness.idempotency.seed(KEY, 'PENDING', { tool: 'Poll', checkpoint: TASK });

      await harness.executor.release([target], { toolSet: async () => toolSetOf(tool), signal: noSignal() });

      expect(released).toEqual([TASK]);
      const lookup = harness.idempotency.port.get(KEY);
      expect(lookup).toMatchObject({ s: 'UNKNOWN' });
      expect(lookup && 'rec' in lookup ? lookup.rec.meta : undefined).not.toHaveProperty('checkpoint');
    });

    it('keeps the record and its checkpoint when the tool fails to release it', async () => {
      const harness = makeHarness();
      const failure = new Error('the server is unreachable');
      const tool = makeTool('Poll', {
        ...WRITE,
        releaseCheckpoint: async () => {
          throw failure;
        },
      });
      harness.idempotency.seed(KEY, 'PENDING', { tool: 'Poll', checkpoint: TASK });

      await expect(harness.executor.release([target], { toolSet: async () => toolSetOf(tool), signal: noSignal() })).rejects.toBe(failure);

      expect(harness.idempotency.port.get(KEY)).toMatchObject({ s: 'PENDING', rec: { meta: { checkpoint: TASK } } });
    });

    it('clears a checkpoint of a tool that has no hook and leaves records without a checkpoint alone', async () => {
      const harness = makeHarness();
      const plain = makeTool('Poll', WRITE);
      harness.idempotency.seed(KEY, 'PENDING', { tool: 'Poll', checkpoint: TASK });
      const otherKey = keyFor('run-1', 1, 'c2');
      harness.idempotency.seed(otherKey, 'PENDING', { tool: 'Poll' });

      await harness.executor.release(
        [target, { callId: 'c2', name: 'Poll', idemKey: otherKey }],
        { toolSet: async () => toolSetOf(plain), signal: noSignal() },
      );

      expect(harness.idempotency.port.get(KEY)).toMatchObject({ s: 'UNKNOWN' });
      expect(harness.idempotency.port.get(otherKey)).toMatchObject({ s: 'PENDING' });
    });

    it('loads the tool set only for a target whose record holds a checkpoint', async () => {
      const harness = makeHarness();
      const plain = makeTool('Poll', WRITE);
      harness.idempotency.seed(KEY, 'PENDING', { tool: 'Poll' });
      let loads = 0;

      await harness.executor.release([target], {
        toolSet: async () => {
          loads += 1;
          return toolSetOf(plain);
        },
        signal: noSignal(),
      });

      expect(loads).toBe(0);
    });

    it('rejects with the abort reason before touching anything when the signal is aborted', async () => {
      const harness = makeHarness();
      harness.idempotency.seed(KEY, 'PENDING', { tool: 'Poll', checkpoint: TASK });
      const aborted = AbortSignal.abort(new Error('closing'));

      await expect(harness.executor.release([target], { toolSet: async () => toolSetOf(makeTool('Poll', WRITE)), signal: aborted })).rejects.toThrow('closing');

      expect(harness.idempotency.port.get(KEY)).toMatchObject({ s: 'PENDING' });
    });
  });
});
