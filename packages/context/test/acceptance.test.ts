import { describe, expect, it } from 'vitest';
import { buildContext } from '@momonga/context';
import {
  call,
  capabilitiesFor,
  expectPairsWhole,
  harness,
  inputFor,
  output,
  outputTextOf,
  sourcesWith,
  tokensOfItems,
  truncatedMarker,
} from './helpers.ts';

describe('acceptance (a) precursor', () => {
  it('keeps a 20k-character current-step tool output within I at W=1024 by storing it behind a handle', async () => {
    const capabilities = capabilitiesFor(1024);
    const { ports, blobs } = harness(capabilities);
    const huge = Array.from({ length: 2000 }, (_, index) => `line ${String(index).padStart(4, '0')}\n`).join('');
    expect(huge.length).toBe(20000);
    const history = [call(1, 'read-1'), output(2, 'read-1', huge)];
    const result = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history }) }), ports);
    expect(result.budget).toEqual({ W: 1024, R: 256, margin: 32, I: 736 });
    expect(result.inputTokens).toBe(tokensOfItems(result.input));
    expect(result.inputTokens).toBeLessThanOrEqual(736);
    expect(blobs.puts).toEqual([{ text: huge, mediaType: expect.any(String) }]);
    const text = outputTextOf(result.input, 'read-1') ?? '';
    expect(truncatedMarker.exec(text)?.[2]).toBe('blob-1');
    expect(result.evictions).toEqual([{ callId: 'read-1', handle: 'blob-1', kind: 'truncated' }]);
    expect(expectPairsWhole(result.input)).toBe(true);
  });
});
