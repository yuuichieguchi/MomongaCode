import { describe, expect, it } from 'vitest';
import { defineTool } from '@momonga/tools';
import type { AnyTool } from '@momonga/tools';
import { capabilitiesFor, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { assistantMessage, callsStep, textStep } from './scripts.ts';
import type { RunEventPayload } from '@momonga/protocol';

const WINDOW = 5_000;
const OUTPUT = 1_024;
const FILLERS = 8;
const FILLER_DESCRIPTION_CHARS = 1_200;
const PAD_CHARS = 1_600;
const HISTORY_CHARS = 1_500;
const USAGE = { input_tokens: 50, output_tokens: 5, total_tokens: 55 };
const SUMMARY = 'GOAL:\ng\nSTATE:\ns\nDONE:\nd\nTODO:\nt\nDECISIONS:\nx\nGUARDRAILS:\ny';

const readOnly = (name: string, descriptionChars: number, output: () => string, extra: Record<string, unknown> = {}): AnyTool =>
  defineTool<Record<string, never>>({
    name,
    description: `${name} ${'x'.repeat(descriptionChars)}`,
    kind: 'other',
    sideEffect: 'read_only',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: 60_000,
    title: () => name,
    subject: () => ({ kind: 'none', tool: name }),
    execute: async () => ({ status: 'completed', output: output() }),
    ...extra,
  } as never);

const tools = (): AnyTool[] => [
  readOnly('Pad', 10, () => 'p'.repeat(PAD_CHARS)),
  ...Array.from({ length: FILLERS }, (_unused, index) => readOnly(`Filler${index}`, FILLER_DESCRIPTION_CHARS, () => 'ok')),
  readOnly('HistoryRead', FILLER_DESCRIPTION_CHARS, () => 'events', { tier: 'optional', reads: 'history_range' }),
];

const responded = (step: number, text: string): RunEventPayload => ({
  type: 'model.responded',
  step,
  attempt: 1,
  response: { status: 'completed', output: [assistantMessage(`m${step}`, text)], usage: USAGE },
});

const history = (): RunEventPayload[] => [
  responded(1, `a ${'x'.repeat(HISTORY_CHARS)}`),
  { type: 'user.message', text: 'question two' },
  responded(2, `b ${'x'.repeat(HISTORY_CHARS)}`),
  { type: 'user.message', text: 'question three' },
];

const toolNamesOf = (body: unknown): string[] => ((body as { tools?: { name: string }[] }).tools ?? []).map((tool) => tool.name);

const envFor = async (observedCapacity: boolean): Promise<Env> => {
  const env = await makeEnv({ capabilities: capabilitiesFor(WINDOW, { maxOutputTokens: OUTPUT }), mode: 'bypassPermissions' });
  env.settings.contextValue = { ...env.settings.contextValue, observedCapacity };
  return env;
};

describe.for([false, true])('the reader of the replaced range joins the admitted tool list at the first compaction (observed capacity %s)', (observedCapacity) => {
  it('is dropped at admission, because no range was replaced yet, and carried by the next request after the compaction', async () => {
    const env = await envFor(observedCapacity);
    const run = env.enqueue('question one');
    env.seed(run.id, history(), 'release');
    env.gateway.compactSummaries.push(SUMMARY);
    env.gateway.script.push(callsStep([{ callId: 'call_pad_1', name: 'Pad', args: {} }]), textStep('Done.'));

    await env.runOnce(env.worker('w1', { toolList: tools }));

    const compacted = env.ofType(run.id, 'context.compacted');
    expect(compacted).toHaveLength(1);
    const offered = env.gateway.streams.map((stream) => toolNamesOf(stream.body));
    expect(offered[0]).not.toContain('HistoryRead');
    expect(offered.at(-1)).toContain('HistoryRead');
    expect(env.run(run.id).status).toBe('COMPLETED');
  });

  it('journals the join as a tool load when the admitted list was frozen', async () => {
    const env = await envFor(observedCapacity);
    const run = env.enqueue('question one');
    env.seed(run.id, history(), 'release');
    env.gateway.compactSummaries.push(SUMMARY);
    env.gateway.script.push(callsStep([{ callId: 'call_pad_1', name: 'Pad', args: {} }]), textStep('Done.'));

    await env.runOnce(env.worker('w1', { toolList: tools }));

    const loaded = env.ofType(run.id, 'tool.loaded');
    expect(loaded.length > 0).toBe(observedCapacity);
    if (observedCapacity) expect(loaded.flatMap((event) => event.names)).toEqual(['HistoryRead']);
  });
});
