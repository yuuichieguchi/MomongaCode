import { describe, expect, it } from 'vitest';
import { readTextLimited } from '../src/adapters/shared/body-reading.ts';

const encoder = new TextEncoder();

async function* chunksOf(parts: readonly string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield encoder.encode(part);
}

describe('readTextLimited', () => {
  it.for([
    { label: 'a body under the limit', parts: ['ab cd!', 'xy!'], max: 20, expected: { text: 'ab cd!xy!', truncated: false } },
    { label: 'a body exactly at the limit', parts: ['ab cd!'], max: 6, expected: { text: 'ab cd!', truncated: false } },
    { label: 'a body cut inside a chunk', parts: ['ab cd! xyz'], max: 6, expected: { text: 'ab cd!', truncated: true } },
    { label: 'a body cut at a chunk boundary', parts: ['ab cd!', ' more'], max: 6, expected: { text: 'ab cd!', truncated: true } },
    { label: 'a cut token containing a percent escape', parts: ['ab cd x%2F', 'more'], max: 10, expected: { text: 'ab cd ', truncated: true } },
    { label: 'a cut token containing a backslash escape', parts: ['ab cd x\\/y', 'zz'], max: 10, expected: { text: 'ab cd ', truncated: true } },
  ])('reports $label with its truncated flag', async ({ parts, max, expected }) => {
    expect(await readTextLimited(chunksOf(parts), max)).toEqual(expected);
  });
});
