import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@momonga/foundation';
import { DETERMINISTIC_SUMMARY_TEXT, compactionSummaryMessage } from '@momonga/protocol';
import type { RunEventPayload } from '@momonga/protocol';
import { GatewayRequestError } from '@momonga/runtime';
import { fixtureCompactionItem } from '@momonga/testkit';
import { defineTool } from '@momonga/tools';
import type { AnyTool } from '@momonga/tools';
import { capabilitiesFor, makeEnv, textOf } from './harness.ts';
import type { Env } from './harness.ts';
import { assistantMessage, textStep } from './scripts.ts';

const WRITTEN = '/proj/src/written.ts';
const USAGE = { input_tokens: 50, output_tokens: 5, total_tokens: 55 };
const WINDOW = 40_000;

const responded = (step: number, output: unknown[]): RunEventPayload => ({ type: 'model.responded', step, attempt: 1, response: { status: 'completed', output, usage: USAGE } });

const toolTurn = (
  step: number,
  callId: string,
  name: string,
  rawInput: unknown,
  output: string,
  extra: Partial<Extract<RunEventPayload, { type: 'tool.completed' }>> = {},
): RunEventPayload[] => [
  responded(step, [{ type: 'function_call', id: `fc_${callId}`, call_id: callId, name, arguments: JSON.stringify(rawInput) }]),
  { type: 'tool.call', callId, providerCallId: callId, name, kind: 'other', title: name, rawInput },
  { type: 'tool.completed', callId, status: 'completed', output, ...extra },
];

const conversation = (handle?: string, readOutput = 'contents'): RunEventPayload[] => [
  ...toolTurn(1, 'c1', 'Write', { file_path: WRITTEN, content: 'x' }, `Created ${WRITTEN}`, { files: [{ path: WRITTEN, sha256: sha256Hex('x'), access: 'write' }] }),
  ...toolTurn(2, 'c2', 'Read', { file_path: '/proj/src/read.ts' }, readOutput, {
    files: [{ path: '/proj/src/read.ts', sha256: sha256Hex('contents'), access: 'read' }],
    ...(handle === undefined ? {} : { handle }),
  }),
  responded(3, [assistantMessage('m3', `long ${'x'.repeat(120_000)}`)]),
  { type: 'user.message', text: 'question two' },
  responded(4, [assistantMessage('m4', 'answer two')]),
  { type: 'user.message', text: 'question three' },
  responded(5, [assistantMessage('m5', 'answer three')]),
  { type: 'user.message', text: 'question four' },
];

const prepare = async (payloads: RunEventPayload[] = conversation()) => {
  const env = await makeEnv({ capabilities: capabilitiesFor(WINDOW) });
  const run = await env.enqueue('question one');
  await env.seed(run.id, payloads, 'release');
  return { env, run };
};

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

const runToEnd = async (env: Env, finalText = 'Done.') => {
  env.gateway.script.push(textStep(finalText));
  expect(await env.runOnce(env.worker('worker-1', { toolList: () => [historyRead] }))).toBe('yielded');
};

const onlyCompaction = (env: Env, runId: string) => {
  const events = env.ofType(runId, 'context.compacted');
  expect(events).toHaveLength(1);
  return events[0]!;
};

const lastInputText = (env: Env): string => {
  const body = env.gateway.streams.at(-1)?.body as { input: unknown[] };
  return body.input.map((item) => textOf(item)).join('\n');
};

const escalating = (): GatewayRequestError => new GatewayRequestError({ status: 422, type: 'invalid_request', code: 'compaction_summary_too_long', message: 'too long' });

const CLEAN = 'GOAL:\ng\nSTATE:\n`/proj/src/read.ts`\nDONE:\nd\nTODO:\n`src/later.ts`\nDECISIONS:\nx\nGUARDRAILS:\ny';
const FABRICATED = 'GOAL:\ng\nSTATE:\n`src/ghost.ts`\nDONE:\nd\nTODO:\nt\nDECISIONS:\nx\nGUARDRAILS:\ny';

describe('a model summary that passes the check', () => {
  it('enters the context as the compaction item with source and fidelity recorded', async () => {
    const { env, run } = await prepare();
    env.gateway.compactSummaries.push(CLEAN);
    await runToEnd(env);
    const event = onlyCompaction(env, run.id);
    expect(event.item.type).toBe('compaction');
    expect(event.summary).toBe(CLEAN);
    expect(event.source).toBe('model');
    expect(event.guidelineVersion).toBe(0);
    expect(event.fidelity).toMatchObject({ fabricated: [], sections: 'complete' });
    expect(env.run(run.id).status).toBe('COMPLETED');
  });

  it('counts the written path as retained through the working state', async () => {
    const { env, run } = await prepare();
    env.gateway.compactSummaries.push(CLEAN);
    await runToEnd(env);
    expect(onlyCompaction(env, run.id).fidelity).toMatchObject({ identifiers: 1, retained: 1 });
  });

  it('reads the replaced region through blobs', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(WINDOW) });
    const run = await env.enqueue('question one');
    const { handle } = await env.store.blobs.put('full output naming src/deep/only-in-blob.ts', { mediaType: 'text/plain', runId: run.id });
    await env.seed(run.id, conversation(handle, 'head [truncated]'), 'release');
    env.gateway.compactSummaries.push(CLEAN.replace('/proj/src/read.ts', 'src/deep/only-in-blob.ts'));
    await runToEnd(env);
    expect(onlyCompaction(env, run.id)).toMatchObject({ source: 'model', fidelity: { fabricated: [] } });
  });

  it('does not accept a token found only in the previous summary', async () => {
    const earlier = 'STATE:\n`src/earlier/kept.ts`';
    const seeded: RunEventPayload = { type: 'context.compacted', item: fixtureCompactionItem('cmp_seed', earlier), summary: earlier, replacedThroughSeq: 3, source: 'model' };
    const [first, second, third, ...rest] = conversation();
    const { env, run } = await prepare([first!, second!, third!, seeded, ...rest]);
    env.gateway.compactSummaries.push(CLEAN.replace('/proj/src/read.ts', 'src/earlier/kept.ts'));
    await runToEnd(env);
    expect(env.ofType(run.id, 'context.compacted').at(-1)).toMatchObject({ source: 'deterministic', fidelity: { fabricated: ['src/earlier/kept.ts'] } });
  });

  it('accepts a GOAL token from the pinned layers', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(WINDOW) });
    env.instructions.files.set(`${env.project}/AGENTS.md`, 'Never touch src/pinned/rule.ts');
    const run = await env.enqueue('question one');
    await env.seed(run.id, conversation(), 'release');
    env.gateway.compactSummaries.push(CLEAN.replace('GOAL:\ng', 'GOAL:\nkeep `src/pinned/rule.ts` untouched'));
    await runToEnd(env);
    expect(onlyCompaction(env, run.id)).toMatchObject({ source: 'model', fidelity: { fabricated: [] } });
  });

  it('does not accept a STATE token found only in the pinned layers', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(WINDOW) });
    env.instructions.files.set(`${env.project}/AGENTS.md`, 'Never touch src/pinned/rule.ts');
    const run = await env.enqueue('question one');
    await env.seed(run.id, conversation(), 'release');
    env.gateway.compactSummaries.push(CLEAN.replace('/proj/src/read.ts', 'src/pinned/rule.ts'));
    await runToEnd(env);
    expect(onlyCompaction(env, run.id)).toMatchObject({ source: 'deterministic', fidelity: { fabricated: ['src/pinned/rule.ts'] } });
  });

  it('does not accept a STATE token found only in the model own earlier message', async () => {
    const payloads = conversation();
    payloads.splice(6, 1, responded(3, [assistantMessage('m3', `I changed src/said/only.ts ${'x'.repeat(120_000)}`)]));
    const { env, run } = await prepare(payloads);
    env.gateway.compactSummaries.push(CLEAN.replace('/proj/src/read.ts', 'src/said/only.ts'));
    await runToEnd(env);
    expect(onlyCompaction(env, run.id)).toMatchObject({ source: 'deterministic', fidelity: { fabricated: ['src/said/only.ts'] } });
  });
});

describe('a fabricated model summary', () => {
  it('is replaced by a deterministic summary and the run continues', async () => {
    const { env, run } = await prepare();
    env.gateway.compactSummaries.push(FABRICATED);
    await runToEnd(env);
    const event = onlyCompaction(env, run.id);
    expect(event.source).toBe('deterministic');
    expect(event.summary).not.toContain('ghost');
    expect(event.item).toEqual(compactionSummaryMessage(event.summary, 'code', env.session.fenceNonce));
    expect(event.fidelity?.fabricated).toEqual(['src/ghost.ts']);
    expect(lastInputText(env)).not.toContain('src/ghost.ts');
    expect(env.run(run.id).status).toBe('COMPLETED');
  });

  it('still charges the model call', async () => {
    const { env, run } = await prepare();
    env.gateway.compactSummaries.push(FABRICATED);
    await runToEnd(env);
    expect(env.ofType(run.id, 'usage.charged').filter((event) => event.purpose === 'compaction')).toHaveLength(1);
  });

  it('calls the model once for the range', async () => {
    const { env } = await prepare();
    env.gateway.compactSummaries.push(FABRICATED);
    await runToEnd(env);
    expect(env.gateway.compacts).toHaveLength(1);
  });
});

describe('an escalating gateway failure', () => {
  const failing = async () => {
    const prepared = await prepare();
    prepared.env.gateway.compactHook = async () => {
      throw escalating();
    };
    return prepared;
  };

  it('gives the deterministic summary and no failure notice', async () => {
    const { env, run } = await failing();
    await runToEnd(env);
    const event = onlyCompaction(env, run.id);
    expect(event.source).toBe('deterministic');
    expect(event.item).toEqual(compactionSummaryMessage(event.summary, 'code', env.session.fenceNonce));
    expect(env.ofType(run.id, 'notice').filter((notice) => notice.message.startsWith('Compaction failed'))).toEqual([]);
    expect(env.run(run.id).status).toBe('COMPLETED');
  });

  it('charges nothing, because no reply came back', async () => {
    const { env, run } = await failing();
    await runToEnd(env);
    expect(env.ofType(run.id, 'usage.charged')).toEqual([]);
  });

  it('leaves a transient failure alone', async () => {
    const { env, run } = await prepare();
    env.gateway.compactHook = async () => {
      throw new GatewayRequestError({ status: 429, type: 'too_many_requests', code: 'too_many_requests', message: 'slow down' });
    };
    await env.runOnce(env.worker());
    expect(env.ofType(run.id, 'context.compacted').filter((event) => event.source === 'deterministic')).toEqual([]);
  });
});

describe('a failure that sent the run to the deterministic summary', () => {
  it('stays visible as a notice that names the code and the message', async () => {
    const { env, run } = await prepare();
    env.gateway.compactHook = async () => {
      throw escalating();
    };
    await runToEnd(env);
    const notices = env.ofType(run.id, 'notice').filter((notice) => notice.message.includes('compaction_summary_too_long'));
    expect(notices).toEqual([expect.objectContaining({ level: 'warning', message: expect.stringContaining('too long') })]);
    const compacted = onlyCompaction(env, run.id);
    expect(notices[0]?.seq).toBeLessThan(compacted.seq);
  });

  it('stays visible as a notice when the model reply was rejected for a fabricated token', async () => {
    const { env, run } = await prepare();
    env.gateway.compactSummaries.push(FABRICATED);
    await runToEnd(env);
    expect(env.ofType(run.id, 'notice').filter((notice) => notice.message.includes('src/ghost.ts'))).toHaveLength(1);
  });

  it('also covers a rejection that names nothing about the summary, with its code in the notice', async () => {
    const { env, run } = await prepare();
    env.gateway.compactHook = async () => {
      throw new GatewayRequestError({ status: 422, type: 'invalid_request', code: 'invalid_request', message: 'bad request' });
    };
    await runToEnd(env);
    expect(onlyCompaction(env, run.id).source).toBe('deterministic');
    expect(env.ofType(run.id, 'notice').filter((notice) => notice.message.startsWith('Compaction summary failed (invalid_request)'))).toHaveLength(1);
    expect(env.run(run.id).status).toBe('COMPLETED');
  });
});

describe('the deterministic summary', () => {
  it('carries no text of the previous model summary', async () => {
    const earlier = 'STATE:\n`src/earlier/kept.ts`';
    const seeded: RunEventPayload = { type: 'context.compacted', item: fixtureCompactionItem('cmp_seed', earlier), summary: earlier, replacedThroughSeq: 3, source: 'model' };
    const [first, second, third, ...rest] = conversation();
    const { env, run } = await prepare([first!, second!, third!, seeded, ...rest]);
    env.gateway.compactSummaries.push(FABRICATED);
    await runToEnd(env);
    const { summary } = env.ofType(run.id, 'context.compacted').at(-1)!;
    expect(summary).toBe(DETERMINISTIC_SUMMARY_TEXT);
    expect(summary).not.toContain('src/earlier/kept.ts');
  });

  it('is the fixed sentence, and the written file, the range and HistoryRead are in the working state that follows', async () => {
    const { env, run } = await prepare();
    env.gateway.compactSummaries.push(FABRICATED);
    await runToEnd(env);
    const { summary, replacedThroughSeq } = onlyCompaction(env, run.id);
    expect(replacedThroughSeq).toBeGreaterThan(0);
    expect(summary).toBe(DETERMINISTIC_SUMMARY_TEXT);
    const body = env.gateway.streams.at(-1)?.body as { input: unknown[] };
    const last = textOf(body.input.at(-1));
    expect(last).toContain(WRITTEN);
    expect(last).toContain('HistoryRead');
    expect(last).toMatch(/seqFrom[ :=]+\d+[\s\S]*seqTo[ :=]+\d+/);
  });

  it('holds no prose from the replaced region', async () => {
    const { env, run } = await prepare();
    env.gateway.compactSummaries.push(FABRICATED);
    await runToEnd(env);
    expect(onlyCompaction(env, run.id).summary).not.toContain('xxxxxxxx');
  });
});

describe('working state in the model request', () => {
  it('is the last input item after a compaction', async () => {
    const { env } = await prepare();
    env.gateway.compactSummaries.push(CLEAN);
    await runToEnd(env);
    const body = env.gateway.streams.at(-1)?.body as { input: unknown[] };
    const last = textOf(body.input.at(-1));
    expect(last).toContain(WRITTEN);
    expect(last).toContain('HistoryRead');
  });
});

describe('replay and recovery', () => {
  it('reuses a recorded deterministic compaction on a new claim', async () => {
    const payloads = conversation();
    const env = await makeEnv({ capabilities: capabilitiesFor(WINDOW) });
    const deterministic = compactionSummaryMessage('recorded', 'code', env.session.fenceNonce);
    const run = await env.enqueue('question one');
    await env.seed(run.id, [...payloads.slice(0, 7), { type: 'context.compacted', item: deterministic, summary: 'recorded', replacedThroughSeq: 6, source: 'deterministic' }, ...payloads.slice(7)], 'crash');
    await runToEnd(env);
    expect(env.gateway.compacts).toEqual([]);
    expect(env.fold(run.id).summary?.item).toEqual(deterministic);
    expect(lastInputText(env)).toContain('recorded');
  });
});

describe('unchanged behaviour', () => {
  it('never rejects a message summary at the gateway', async () => {
    const env = await makeEnv();
    const run = await env.enqueue('question one');
    await env.seed(run.id, [responded(1, [assistantMessage('m1', 'a')]), { type: 'user.message', text: 'q2' }, { type: 'context.compacted', item: compactionSummaryMessage('s', 'code', env.session.fenceNonce), summary: 's', replacedThroughSeq: 2, source: 'deterministic' }], 'release');
    await runToEnd(env);
    expect(env.ofType(run.id, 'context.compaction_rejected')).toEqual([]);
    expect(env.run(run.id).status).toBe('COMPLETED');
  });

  it('still stops on a CompactionBlock, with no deterministic summary', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(8192) });
    const run = await env.enqueue('question one');
    await env.seed(run.id, [responded(1, [assistantMessage('m1', 'y'.repeat(60_000))]), { type: 'user.message', text: 'question two' }], 'release');
    await env.runOnce(env.worker());
    expect(env.ofType(run.id, 'context.compacted')).toEqual([]);
    expect(env.gateway.compacts).toEqual([]);
    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'budget' });
  });
});
