import { describe, expect, it } from 'vitest';
import type { ToolContext } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';

const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

describe('executor trace context plumbing', () => {
  it('passes traceparentFor(callId) into ToolContext.traceparent and tracestate per call', async () => {
    const harness = makeHarness();
    const seen = new Map<string, { traceparent: string | undefined; tracestate: string | undefined }>();
    const tool = makeTool('Traced', {
      execute: async (_input, ctx: ToolContext) => {
        seen.set(ctx.callId, { traceparent: ctx.traceparent, tracestate: ctx.tracestate });
        return { status: 'completed', output: 'ok' };
      },
    });
    const requested: string[] = [];
    await harness.executor.runBatch(
      await harness.input(await toolSetOf(tool), [call('c1', 'Traced'), call('c2', 'Traced'), call('c3', 'Traced')], {
        traceparentFor: (callId: string) => {
          requested.push(callId);
          if (callId === 'c1') return { traceparent: TRACEPARENT, tracestate: 'vendor=one' };
          if (callId === 'c2') return { traceparent: TRACEPARENT.replace('-01', '-00') };
          return undefined;
        },
      }),
    );
    expect([...requested].sort()).toEqual(['c1', 'c2', 'c3']);
    expect(seen.get('c1')).toEqual({ traceparent: TRACEPARENT, tracestate: 'vendor=one' });
    expect(seen.get('c2')).toEqual({ traceparent: TRACEPARENT.replace('-01', '-00'), tracestate: undefined });
    expect(seen.get('c3')).toEqual({ traceparent: undefined, tracestate: undefined });
  });

  it('leaves the trace fields absent when traceparentFor is not provided', async () => {
    const harness = makeHarness();
    let ctxSeen: ToolContext | undefined;
    const tool = makeTool('Untraced', {
      execute: async (_input, ctx: ToolContext) => {
        ctxSeen = ctx;
        return { status: 'completed', output: 'ok' };
      },
    });
    await harness.executor.runBatch(await harness.input(await toolSetOf(tool), [call('c1', 'Untraced')]));
    expect(ctxSeen).toBeDefined();
    expect('traceparent' in (ctxSeen as ToolContext)).toBe(false);
    expect('tracestate' in (ctxSeen as ToolContext)).toBe(false);
  });
});
