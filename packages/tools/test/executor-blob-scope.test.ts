import { describe, expect, it } from 'vitest';
import type { BlobPort } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';

const recordingBlobs = () => {
  const puts: Array<{ runId?: string }> = [];
  const reads: Array<{ runId: string } | undefined> = [];
  const port = {
    put: (_data: string, options: { runId?: string }) => {
      puts.push(options);
      return { handle: 'ab'.repeat(32), sha256: 'ab'.repeat(32), byteLength: 1, lineCount: 1 };
    },
    read: (_handle: string, _range: unknown, scope?: { runId: string }) => {
      reads.push(scope);
      return Promise.resolve({ text: 'x', totalLines: 1, totalBytes: 1 });
    },
  } as unknown as BlobPort;
  return { port, puts, reads };
};

describe('blobs handed to a tool', () => {
  it('are scoped to the run of the call, for a read, a put and the truncation of an oversized result', async () => {
    const { port, puts, reads } = recordingBlobs();
    const harness = makeHarness({ outputLimitChars: 200, executor: { blobs: port } });
    const tool = makeTool('Scoped', {
      execute: async (_input, ctx) => {
        ctx.blobs.put('data', { mediaType: 'text/plain' });
        await ctx.blobs.read('ab'.repeat(32), { lineStart: 1, lineEnd: 1 });
        return { status: 'completed', output: 'line\n'.repeat(200) };
      },
    });
    await harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('c1', 'Scoped', {})]));
    expect(reads).toEqual([{ runId: 'run-1' }]);
    expect(puts.map((entry) => entry.runId)).toEqual(['run-1', 'run-1']);
  });
});
