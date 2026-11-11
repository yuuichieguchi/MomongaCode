import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@momonga/foundation';
import type { RunEventPayload } from '@momonga/protocol';
import { capabilitiesFor, makeEnv } from './harness.ts';
import { assistantMessage, textStep } from './scripts.ts';

const WRITTEN = '/proj/src/written-once.ts';
const USAGE = { input_tokens: 50, output_tokens: 5, total_tokens: 55 };
const WINDOW = 40_000;
const FABRICATED = 'GOAL:\ng\nSTATE:\n`src/ghost.ts`\nDONE:\nd\nTODO:\nt\nDECISIONS:\nx\nGUARDRAILS:\ny';

const responded = (step: number, output: unknown[]): RunEventPayload => ({ type: 'model.responded', step, attempt: 1, response: { status: 'completed', output, usage: USAGE } });

const journal = (): RunEventPayload[] => [
  responded(1, [{ type: 'function_call', id: 'fc_c1', call_id: 'c1', name: 'Write', arguments: JSON.stringify({ file_path: WRITTEN, content: 'x' }) }]),
  { type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Write', kind: 'other', title: 'Write', rawInput: { file_path: WRITTEN, content: 'x' } },
  { type: 'tool.completed', callId: 'c1', status: 'completed', output: 'done', files: [{ path: WRITTEN, sha256: sha256Hex('x'), access: 'write' }] },
  responded(2, [assistantMessage('m2', `long ${'x'.repeat(120_000)}`)]),
  { type: 'user.message', text: 'question two' },
  responded(3, [assistantMessage('m3', 'answer two')]),
  { type: 'user.message', text: 'question three' },
  responded(4, [assistantMessage('m4', 'answer three')]),
  { type: 'user.message', text: 'question four' },
];

describe('a deterministic compaction states each fact once', () => {
  it('leaves one occurrence of a written path in the built input, in the working state', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(WINDOW) });
    const run = await env.enqueue('question one');
    await env.seed(run.id, journal(), 'release');
    env.gateway.compactSummaries.push(FABRICATED);
    env.gateway.script.push(textStep('Done.'));
    expect(await env.runOnce(env.worker())).toBe('yielded');
    expect(env.ofType(run.id, 'context.compacted').at(-1)?.source).toBe('deterministic');
    const input = JSON.stringify((env.gateway.streams.at(-1)?.body as { input: unknown[] }).input);
    expect(input.split(WRITTEN)).toHaveLength(2);
  });
});
