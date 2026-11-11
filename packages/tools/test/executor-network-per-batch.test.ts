import { describe, expect, it } from 'vitest';
import type { OutboundNetwork } from '@momonga/foundation';
import type { ToolContext } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';

const networkWithProxy = (proxy: string): OutboundNetwork => ({ config: { httpsProxy: { value: proxy, source: 'network.httpsProxy' }, caFiles: [] }, trust: { sources: [], failures: [] } });

describe('the outbound network of a tool call', () => {
  it('is derived at the start of each batch, so a changed network setting reaches the next call', async () => {
    const answers = [networkWithProxy('http://a.invalid:1'), networkWithProxy('http://b.invalid:1')];
    const asked: AbortSignal[] = [];
    const harness = makeHarness({
      executor: {
        outboundNetwork: async (signal: AbortSignal) => {
          asked.push(signal);
          const next = answers.shift();
          if (next === undefined) throw new Error('asked for a third network');
          return next;
        },
      },
    });
    const seen: OutboundNetwork[] = [];
    const tool = makeTool('Probe', {
      execute: async (_input: unknown, ctx: ToolContext) => {
        seen.push(ctx.outboundNetwork);
        return { status: 'completed', output: 'ok' };
      },
    });
    const toolSet = await toolSetOf(tool);
    await harness.executor.runBatch(await harness.input(toolSet, [call('c1', 'Probe')]));
    await harness.executor.runBatch(await harness.input(toolSet, [call('c2', 'Probe')]));

    expect(seen.map((network) => network.config.httpsProxy?.value)).toEqual(['http://a.invalid:1', 'http://b.invalid:1']);
    expect(asked).toHaveLength(2);
  });
});
