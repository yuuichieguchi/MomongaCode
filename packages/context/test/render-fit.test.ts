import { describe, expect, it } from 'vitest';
import { buildContext, fitToTokens, measurePinned } from '@momonga/context';
import { call, capabilitiesFor, handleOf, harness, inputFor, output, outputTextOf, sourcesWith, tokensOfItem, truncatedMarker } from './helpers.ts';

const capabilities = capabilitiesFor(4000);

const ASCII = Array.from({ length: 2000 }, (_unused, index) => `row ${index + 1} of a wide listing`).join('\n');
const JAPANESE = 'テスト結果を確認しています。'.repeat(1430).slice(0, 20_000);

const envelopedCount = (text: string): number => tokensOfItem({ type: 'function_call_output', id: 'h2', call_id: 'big', output: text });

const markers = (text: string): number => text.split('ReadOutput').length - 1;

describe('the render keeps each tool output at most itemCap(room) tokens on the real build', () => {
  it.each([
    ['ASCII', ASCII],
    ['Japanese', JAPANESE],
  ])('%s output of the raw size', async (_name, raw) => {
    const sources = sourcesWith({ history: [call(1, 'big'), output(2, 'big', raw)] });
    const input = inputFor(capabilities, { sources });
    const { itemCap } = await measurePinned(input, harness(capabilities).ports);
    const built = await buildContext(input, harness(capabilities).ports);
    const rendered = built.input.find((item) => item.type === 'function_call_output');
    expect(tokensOfItem(rendered as Parameters<typeof tokensOfItem>[0])).toBeLessThanOrEqual(itemCap);
    const text = outputTextOf(built.input, 'big') ?? '';
    expect(markers(text)).toBe(1);
    expect(truncatedMarker.exec(text)?.[2]).toBe(handleOf(raw));
  });

  it('a text journaled at a larger cap is cut again at the render with one marker and the same handle', async () => {
    const handle = handleOf(ASCII);
    const journaled = await fitToTokens({ text: ASCII, cap: 600, handle, reader: 'ReadOutput', count: envelopedCount });
    expect(markers(journaled)).toBe(1);
    const sources = sourcesWith({ history: [call(1, 'big'), output(2, 'big', journaled, handle)] });
    const built = await buildContext(inputFor(capabilities, { sources, itemCap: 300 }), harness(capabilities).ports);
    const text = outputTextOf(built.input, 'big') ?? '';
    const rendered = built.input.find((item) => item.type === 'function_call_output');
    expect(tokensOfItem(rendered as Parameters<typeof tokensOfItem>[0])).toBeLessThanOrEqual(300);
    expect(markers(text)).toBe(1);
    expect(truncatedMarker.exec(text)?.[2]).toBe(handle);
  });

  it('a text journaled at the same cap is rendered unchanged', async () => {
    const handle = handleOf(ASCII);
    const journaled = await fitToTokens({ text: ASCII, cap: 300, handle, reader: 'ReadOutput', count: envelopedCount });
    const sources = sourcesWith({ history: [call(1, 'big'), output(2, 'big', journaled, handle)] });
    const built = await buildContext(inputFor(capabilities, { sources, itemCap: 300 }), harness(capabilities).ports);
    expect(outputTextOf(built.input, 'big')).toBe(journaled);
  });
});
