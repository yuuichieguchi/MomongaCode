import { describe, expect, it } from 'vitest';
import { compactionSummaryMessage } from '@momonga/protocol';
import type { RunEventPayload } from '@momonga/protocol';
import { defineTool } from '@momonga/tools';
import type { AnyTool } from '@momonga/tools';
import { makeEnv, textOf } from './harness.ts';
import { assistantMessage, textStep } from './scripts.ts';

const USAGE = { input_tokens: 5, output_tokens: 1, total_tokens: 6 };

const historyRead: AnyTool = defineTool<Record<string, unknown>>({
  name: 'HistoryRead',
  description: 'Reads the recorded events of a run in a seq range.',
  tier: 'optional',
  reads: 'history_range',
  kind: 'read',
  sideEffect: 'read_only',
  subject: () => ({ kind: 'none', tool: 'HistoryRead' }),
  inputSchema: { type: 'object', properties: { seqFrom: { type: 'integer' }, seqTo: { type: 'integer' } }, additionalProperties: false },
  timeoutMs: 1_000,
  title: () => 'HistoryRead',
  execute: async () => ({ status: 'completed' as const, output: 'events' }),
} as never);

const compactedJournal = (): RunEventPayload[] => [
  { type: 'model.responded', step: 1, attempt: 1, response: { status: 'completed', output: [assistantMessage('m1', 'answer one')], usage: USAGE } },
  { type: 'user.message', text: 'question two' },
  { type: 'context.compacted', item: compactionSummaryMessage('GOAL:\ng', 'model'), summary: 'GOAL:\ng', replacedThroughSeq: 2, source: 'model' },
  { type: 'user.message', text: 'question three' },
];

const workingStateOf = async (deny: boolean): Promise<{ text: string; status: string }> => {
  const env = await makeEnv();
  if (deny) env.settings.extraRules.push({ effect: 'deny', rule: 'HistoryRead' });
  const run = env.enqueue('question one');
  env.seed(run.id, compactedJournal(), 'release');
  env.gateway.script.push(textStep('Done.'));
  expect(await env.runOnce(env.worker('worker-1', { toolList: () => [historyRead] }))).toBe('yielded');
  const body = env.gateway.streams.at(-1)?.body as { input: unknown[] } | undefined;
  const text = (body?.input ?? []).map((item) => textOf(item)).find((entry) => entry.includes('<working_state>')) ?? '';
  return { text, status: env.run(run.id).status };
};

describe('a deny rule on the reader of the replaced range', () => {
  it('gives the unreadable form of the pointer and the run still builds', async () => {
    const { text, status } = await workingStateOf(true);
    expect(text).toMatch(/replaced: seq 1-\d+ \(recorded; no tool in this run reads it\)/);
    expect(text).not.toContain('HistoryRead');
    expect(status).toBe('COMPLETED');
  });

  it('names HistoryRead when nothing denies it', async () => {
    const { text, status } = await workingStateOf(false);
    expect(text).toMatch(/replaced: HistoryRead seqFrom: 1, seqTo: \d+/);
    expect(status).toBe('COMPLETED');
  });
});
