import { describe, expect, it } from 'vitest';
import { ToolInputRequired } from '@momonga/tools';
import type { ToolResume } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { keyFor } from './helpers.ts';

const REQUESTS = [{ key: 'who', mode: 'form' as const, message: 'Who?', requestedSchema: { type: 'object' } }];
const WRITE = { sideEffect: 'write' as const, kind: 'other' as const };

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
});
