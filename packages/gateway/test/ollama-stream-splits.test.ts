import { describe, expect, it } from 'vitest';
import type { AdapterRequest, StreamEvent } from '@momonga/protocol';
import { createFakeClock } from '@momonga/testkit';
import { ollamaEventsOf } from '../src/adapters/ollama/stream.ts';
import { START_MS } from './gateway-helpers.ts';
import { expectSpecValid, terminalOf } from './cc-support.ts';
import { LONG_TEXT_THEN_TOOL_CALL, QWEN_NATIVE_THINKING, SHORT_TOOL_CALL, chunkLine, doneLine, fixtureText, seededRandom } from './ollama-support.ts';

const request: AdapterRequest = { model: 'devstral-small-2', input: [{ type: 'message', role: 'user', content: 'go' }], max_output_tokens: 300 };

const SEEDS = Array.from({ length: 40 }, (_, index) => 7919 * (index + 1));

const splitAt = (bytes: Uint8Array, cuts: readonly number[]): Uint8Array[] => {
  const bounds = [0, ...[...new Set(cuts)].filter((cut) => cut > 0 && cut < bytes.length).sort((a, b) => a - b), bytes.length];
  return bounds.slice(1).map((end, index) => bytes.slice(bounds[index], end));
};

const randomSplit = (bytes: Uint8Array, seed: number): Uint8Array[] => {
  const random = seededRandom(seed);
  const count = 1 + Math.floor(random() * Math.min(64, bytes.length));
  return splitAt(bytes, Array.from({ length: count }, () => Math.floor(random() * bytes.length)));
};

const everyByte = (bytes: Uint8Array): Uint8Array[] => Array.from(bytes, (_, index) => bytes.slice(index, index + 1));

async function* readsOf(parts: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield part;
}

const eventsOf = async (parts: readonly Uint8Array[]): Promise<StreamEvent[]> => {
  const events: StreamEvent[] = [];
  for await (const event of ollamaEventsOf(readsOf(parts), { request, clock: createFakeClock(START_MS), signal: new AbortController().signal })) events.push(event);
  return events;
};

type Expected = { text: string; reasoning: string; calls: Array<{ call_id: string; name: string; arguments: unknown }>; usage: { input: number; output: number; cached: number } };

const expectedOf = (ndjson: string): Expected => {
  const chunks = ndjson
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
  const done = chunks.at(-1);
  return {
    text: chunks.map((chunk) => chunk.message?.content ?? '').join(''),
    reasoning: chunks.map((chunk) => chunk.message?.thinking ?? '').join(''),
    calls: chunks.flatMap((chunk) => chunk.message?.tool_calls ?? []).map((call: any) => ({ call_id: call.id, name: call.function.name, arguments: call.function.arguments })),
    usage: { input: done.prompt_eval_count, output: done.eval_count, cached: done.prompt_eval_cached_count ?? 0 },
  };
};

const observedOf = (events: readonly StreamEvent[]): Expected => {
  const terminal = terminalOf(events);
  const output: any[] = terminal.response.output;
  const deltas = (type: string) =>
    events
      .filter((event) => event.type === type)
      .map((event) => (event as { delta: string }).delta)
      .join('');
  return {
    text: deltas('response.output_text.delta'),
    reasoning: deltas('response.reasoning.delta'),
    calls: output.filter((item) => item.type === 'function_call').map((item) => ({ call_id: item.call_id, name: item.name, arguments: JSON.parse(item.arguments) })),
    usage: {
      input: terminal.response.usage.input_tokens,
      output: terminal.response.usage.output_tokens,
      cached: terminal.response.usage.input_tokens_details.cached_tokens,
    },
  };
};

const TWO_CALLS = [
  chunkLine({ content: 'ファイルを読みます。' }),
  chunkLine({ tool_calls: [{ id: 'call_first', function: { index: 0, name: 'Read', arguments: { file_path: 'a.txt' } } }] }),
  chunkLine({ tool_calls: [{ id: 'call_second', function: { index: 1, name: 'Read', arguments: { file_path: 'b/ü.txt', limit: 20 } } }] }),
  doneLine({ prompt_eval_count: 512, prompt_eval_cached_count: 500, eval_count: 61 }),
]
  .map((line) => `${line}\n`)
  .join('');

const STREAMS: Record<string, string> = {
  [SHORT_TOOL_CALL]: fixtureText(SHORT_TOOL_CALL),
  [LONG_TEXT_THEN_TOOL_CALL]: fixtureText(LONG_TEXT_THEN_TOOL_CALL),
  [QWEN_NATIVE_THINKING]: fixtureText(QWEN_NATIVE_THINKING),
  'text and two calls': TWO_CALLS,
};

describe('ollama stream (I2, I3): the same items and usage for any split of the NDJSON into reads', () => {
  for (const [name, ndjson] of Object.entries(STREAMS)) {
    const bytes = new TextEncoder().encode(ndjson);
    const expected = expectedOf(ndjson);

    it(`${name}: the whole body in one read`, async () => {
      const events = await eventsOf([bytes]);
      expect(expectSpecValid(events)).toEqual([]);
      expect(observedOf(events)).toEqual(expected);
    });

    it(`${name}: one byte per read, splitting multibyte characters`, async () => {
      expect(observedOf(await eventsOf(everyByte(bytes)))).toEqual(expected);
    });

    it(`${name}: ${SEEDS.length} seeded random splits`, async () => {
      for (const seed of SEEDS) {
        const events = await eventsOf(randomSplit(bytes, seed));
        expect({ seed, observed: observedOf(events) }).toEqual({ seed, observed: expected });
        const calls = events.filter((event) => event.type === 'response.output_item.done' && event.item.type === 'function_call');
        expect(calls).toHaveLength(expected.calls.length);
      }
    });
  }
});
