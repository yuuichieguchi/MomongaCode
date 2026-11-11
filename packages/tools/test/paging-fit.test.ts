import { describe, expect, it } from 'vitest';
import { readOutputTool } from '../src/builtins/read-output.ts';
import { call, makeHarness, toolSetOf } from './harness.ts';

const LIMIT = 400;

const port = {
  fits: async (text: string): Promise<boolean> => text.length <= LIMIT,
  fit: async (text: string, handle: string): Promise<string> => (text.length <= LIMIT ? text : `${text.slice(0, 40)}\n[cut; ${handle}]`),
};

const CONTINUE = /\n\[Showed lines (\d+)–(\d+)\. Continue with offset=(\d+)\.\]$/;

describe('a paging tool sizes its page by ctx.outputFit', () => {
  it('ReadOutput returns a page the port says fits, notes where to continue, and is never cut', async () => {
    const harness = makeHarness();
    const lines = Array.from({ length: 300 }, (_unused, index) => `out ${index + 1}`);
    const { handle } = await harness.blobs.port.put(lines.join('\n'), { mediaType: 'text/plain; charset=utf-8' });
    const putsBefore = harness.blobs.puts.length;
    const [outcome] = await harness.executor.runBatch({
      ...(await harness.input(await toolSetOf(readOutputTool), [call('c1', 'ReadOutput', { handle })])),
      outputFit: port,
    });
    if (outcome?.kind !== 'result') throw new Error('expected a result');
    const page = outcome.result.output;
    expect(outcome.result.truncated).toBeUndefined();
    expect(harness.blobs.puts.length).toBe(putsBefore);
    expect(page.length).toBeLessThanOrEqual(LIMIT);
    const note = CONTINUE.exec(page);
    expect(note).not.toBeNull();
    const shown = Number((note as RegExpExecArray)[2]);
    expect(shown).toBeGreaterThan(10);
    expect(shown).toBeLessThan(300);
    expect(Number((note as RegExpExecArray)[3])).toBe(shown + 1);
  });
});
