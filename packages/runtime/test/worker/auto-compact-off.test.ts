import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { capabilitiesFor, makeEnv } from './harness.ts';
import { assistantMessage, textStep } from './scripts.ts';

const USAGE = { input_tokens: 50, output_tokens: 5, total_tokens: 55 };
const WINDOW = 40_000;
const HANDLE = 'f'.repeat(64);

const responded = (step: number, output: unknown[]): RunEventPayload => ({ type: 'model.responded', step, attempt: 1, response: { status: 'completed', output, usage: USAGE } });

const conversation: RunEventPayload[] = [
  responded(1, [{ type: 'function_call', id: 'fc_c1', call_id: 'c1', name: 'Read', arguments: '{"file_path":"/proj/big.txt"}' }]),
  { type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Read', kind: 'other', title: 'Read', rawInput: { file_path: '/proj/big.txt' } },
  { type: 'tool.completed', callId: 'c1', status: 'completed', output: 'r'.repeat(60_000), handle: HANDLE },
  responded(2, [assistantMessage('m2', `long ${'x'.repeat(60_000)}`)]),
  { type: 'user.message', text: 'question two' },
  responded(3, [assistantMessage('m3', `answer two ${'y'.repeat(60_000)}`)]),
  { type: 'user.message', text: 'question three' },
  responded(4, [assistantMessage('m4', `answer three ${'z'.repeat(60_000)}`)]),
  { type: 'user.message', text: 'question four' },
];

const runSeeded = async (autoCompact: boolean) => {
  const env = await makeEnv({ capabilities: capabilitiesFor(WINDOW) });
  env.settings.contextValue = { ...env.settings.contextValue, adaptiveBudget: false, autoCompact };
  const run = env.enqueue('question one');
  env.seed(run.id, conversation, 'release');
  env.gateway.script.push(textStep('Done.'));
  await env.runOnce(env.worker());
  return { env, run };
};

describe('context.autoCompact false', () => {
  it('compacts this conversation when the setting is on', async () => {
    const { env, run } = await runSeeded(true);
    expect(env.ofType(run.id, 'context.compacted')).toHaveLength(1);
  });

  it('never asks for a summary and records no compaction', async () => {
    const { env, run } = await runSeeded(false);
    expect(env.gateway.compacts).toEqual([]);
    expect(env.ofType(run.id, 'context.compacted')).toEqual([]);
  });

  it('still evicts the old tool output', async () => {
    const { env, run } = await runSeeded(false);
    expect(env.ofType(run.id, 'context.truncated').filter((event) => event.kind === 'omitted' && event.callId === 'c1')).toHaveLength(1);
    expect(env.gateway.compacts).toEqual([]);
  });

  it('stops with the existing overflow outcome and says why in words a person can read', async () => {
    const { env, run } = await runSeeded(false);
    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'budget' });
    const messages = env.ofType(run.id, 'notice').map((event) => event.message);
    expect(messages.filter((message) => message.includes('compaction is off (context.autoCompact is false)'))).toHaveLength(1);
  });
});
