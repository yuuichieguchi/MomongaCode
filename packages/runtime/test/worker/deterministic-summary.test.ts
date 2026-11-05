import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@momonga/foundation';
import { DETERMINISTIC_SUMMARY_TEXT, MIN_SUMMARY_TOKENS, compactionSummaryMessage, tokensForText } from '@momonga/protocol';
import type { RunEventPayload } from '@momonga/protocol';
import { GatewayRequestError } from '@momonga/runtime';
import { fixtureCompactionItem } from '@momonga/testkit';
import { capabilitiesFor, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { assistantMessage, textStep } from './scripts.ts';

const WRITTEN = '/proj/src/written.ts';
const USAGE = { input_tokens: 50, output_tokens: 5, total_tokens: 55 };
const WINDOW = 40_000;
const MARKER = 'PREVIOUS-MODEL-PROSE-MARKER';
const FABRICATED = 'GOAL:\ng\nSTATE:\n`src/ghost.ts`\nDONE:\nd\nTODO:\nt\nDECISIONS:\nx\nGUARDRAILS:\ny';

const responded = (step: number, output: unknown[]): RunEventPayload => ({ type: 'model.responded', step, attempt: 1, response: { status: 'completed', output, usage: USAGE } });

const journal = (): RunEventPayload[] => {
  const earlier = `GOAL:\n${MARKER} keeps the parser green\nDECISIONS:\n${MARKER} chose plan B`;
  return [
    responded(1, [{ type: 'function_call', id: 'fc_c1', call_id: 'c1', name: 'Write', arguments: JSON.stringify({ file_path: WRITTEN, content: 'x' }) }]),
    { type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Write', kind: 'other', title: 'Write', rawInput: { file_path: WRITTEN, content: 'x' } },
    { type: 'tool.completed', callId: 'c1', status: 'completed', output: `Created ${WRITTEN}`, files: [{ path: WRITTEN, sha256: sha256Hex('x'), access: 'write' }] },
    { type: 'context.compacted', item: fixtureCompactionItem('cmp_seed', earlier), summary: earlier, replacedThroughSeq: 3, source: 'model' },
    responded(2, [assistantMessage('m2', `long ${'x'.repeat(120_000)}`)]),
    { type: 'user.message', text: 'question two' },
    responded(3, [assistantMessage('m3', 'answer two')]),
    { type: 'user.message', text: 'question three' },
    responded(4, [assistantMessage('m4', 'answer three')]),
    { type: 'user.message', text: 'question four' },
  ];
};

const escalating = (): GatewayRequestError => new GatewayRequestError({ status: 422, type: 'invalid_request', code: 'compaction_summary_too_long', message: 'too long' });

const deterministicAfter = async (cause: 'escalating' | 'rejected') => {
  const env: Env = await makeEnv({ capabilities: capabilitiesFor(WINDOW) });
  const run = env.enqueue('question one');
  env.seed(run.id, journal(), 'release');
  if (cause === 'escalating') {
    env.gateway.compactHook = async () => {
      throw escalating();
    };
  } else {
    env.gateway.compactSummaries.push(FABRICATED);
  }
  env.gateway.script.push(textStep('Done.'));
  expect(await env.runOnce(env.worker())).toBe('yielded');
  const event = env.ofType(run.id, 'context.compacted').at(-1)!;
  expect(event.source).toBe('deterministic');
  return { env, run, event };
};

describe('a deterministic summary holds no model text', () => {
  it('names the fixed sentence', () => {
    expect(DETERMINISTIC_SUMMARY_TEXT).toBe(
      'A model summary of the earlier events is not available. The facts recorded by code are in the working state; the recorded events are the record.',
    );
  });

  it.each(['escalating', 'rejected'] as const)('after a %s compaction is the fixed sentence in its code frame, with no previous prose', async (cause) => {
    const { event } = await deterministicAfter(cause);
    expect(event.summary).not.toContain(MARKER);
    expect(event.summary).toBe(DETERMINISTIC_SUMMARY_TEXT);
    expect(event.item).toEqual(compactionSummaryMessage(DETERMINISTIC_SUMMARY_TEXT, 'code'));
  });

  it('keeps the previous prose out of the next model request', async () => {
    const { env } = await deterministicAfter('rejected');
    expect(JSON.stringify(env.gateway.streams.at(-1)?.body)).not.toContain(MARKER);
  });

  it('gives identical bytes for two runs of the same journal', async () => {
    const first = await deterministicAfter('escalating');
    const second = await deterministicAfter('escalating');
    expect(JSON.stringify(second.event.item)).toBe(JSON.stringify(first.event.item));
    expect(second.event.summary).toBe(first.event.summary);
  });

  it('fits every cap, so its estimate is at most MIN_SUMMARY_TOKENS', () => {
    expect(tokensForText(DETERMINISTIC_SUMMARY_TEXT)).toBeLessThanOrEqual(MIN_SUMMARY_TOKENS);
  });
});
