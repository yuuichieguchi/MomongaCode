import { describe, expect, it } from 'vitest';
import { openDatabase } from '@momonga/foundation';
import type { RunEventPayload } from '@momonga/protocol';
import { contributionAtTerminal, pinnedDigestOf } from '@momonga/runtime';
import { createJournalReader, foldRunState, initialRunState } from '@momonga/store';
import type { ContributionPreparer, RuntimeStore } from '@momonga/store';
import { makeEnv } from './harness.ts';
import { LARGE_RUN_SETUP_TEST_TIMEOUT_MS } from './pause-budget.ts';
import { functionCallItem } from './scripts.ts';

const OUTPUT_CHARS = 30_000;
const MEMORIES = 40;
const HISTORY_IN_REQUEST = 8;
const TOOL_COUNT = 30;
const SIZES = [100, 150, 200] as const;

const ascii = (seed: number): string =>
  Array.from({ length: Math.ceil(OUTPUT_CHARS / 2 / 52) }, (_unused, line) => `line-${String(seed * 1000 + line).padStart(7, '0')} src/module${seed}/file${line}.ts handler`).join('\n').slice(0, OUTPUT_CHARS / 2);

const japanese = (seed: number): string =>
  Array.from({ length: Math.ceil(OUTPUT_CHARS / 2 / 20) }, (_unused, line) => `設定ファイル${seed}の読み込み${line}に失敗しました。`).join('\n').slice(0, OUTPUT_CHARS / 2);

const outputs = new Map<number, string>();

const outputOf = (step: number): string => {
  const cached = outputs.get(step);
  if (cached !== undefined) return cached;
  const output = `${ascii(step)}\n${japanese(step)}`;
  outputs.set(step, output);
  return output;
};

const SYSTEM_PROMPT = Array.from({ length: 120 }, (_unused, line) => `Rule ${line}: keep the change small and verify it before you answer.`).join('\n');
const TOOLS = Array.from({ length: TOOL_COUNT }, (_unused, index) => ({
  type: 'function',
  name: `Tool${index}`,
  description: `Tool number ${index} reads or changes something in the workspace and reports what it found. `.repeat(8),
  parameters: { type: 'object', properties: { file_path: { type: 'string', description: 'absolute path of the file' } } },
}));

const requestOf = (step: number): RunEventPayload => {
  const body = {
    model: 'fm',
    input: [
      { type: 'message', role: 'system', content: SYSTEM_PROMPT },
      { type: 'message', role: 'developer', content: 'Instruction file: prefer small commits.' },
      ...Array.from({ length: Math.min(HISTORY_IN_REQUEST, step - 1) }, (_unused, offset) => ({
        type: 'function_call_output',
        call_id: `call_${step - 1 - offset}`,
        output: outputOf(step - 1 - offset),
      })),
    ],
    tools: TOOLS,
    tool_choice: 'auto',
  };
  return { type: 'model.requested', step, attempt: 1, digest: `digest-${step}`, pinnedDigest: pinnedDigestOf(body), body };
};

const stepEvents = (step: number): RunEventPayload[] => {
  const callId = `call_${step}`;
  const args = { value: `step ${step} zorpWord${step % MEMORIES}` };
  return [
    requestOf(step),
    { type: 'model.responded', step, attempt: 1, response: { status: 'completed', output: [functionCallItem({ callId, name: 'Echo', args })], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    { type: 'tool.call', callId, providerCallId: callId, name: 'Echo', kind: 'read', title: 'Echo', rawInput: args },
    { type: 'tool.completed', callId, status: 'completed', output: outputOf(step) },
  ];
};

type Counts = { decodedRows: number; decodedBytes: number; encodedBytes: number };

type Path = 'thread' | 'inline';

const threadDouble = (dbPath: () => string): ContributionPreparer => ({
  measure: async (request) => {
    const db = openDatabase(dbPath());
    try {
      return createJournalReader(db).measure(contributionAtTerminal, request);
    } finally {
      db.close();
    }
  },
});

const inlineControl = (store: () => RuntimeStore): ContributionPreparer => ({
  measure: async (request) => {
    const events = store().readRunEvents(request.runId, 0, 1_000_000);
    const run = store().getRun(request.runId);
    return { lastSeq: run?.lastSeq ?? -1, contribution: { type: 'context.contribution', items: [{ kind: 'memory', id: `events-${events.length}`, contributed: false }] } };
  },
});

const terminalCounts = async (steps: number, path: Path): Promise<Counts> => {
  const counting = { on: false, counts: { decodedRows: 0, decodedBytes: 0, encodedBytes: 0 } };
  let boundStore: RuntimeStore | undefined;
  let boundPath = '';
  const env = await makeEnv({
    mode: 'bypassPermissions',
    preparer: path === 'thread' ? threadDouble(() => boundPath) : inlineControl(() => boundStore as RuntimeStore),
    onDecode: (rows: number, bytes: number) => {
      if (!counting.on) return;
      counting.counts.decodedRows += rows;
      counting.counts.decodedBytes += bytes;
    },
    onEncode: (_kind: string, bytes: number) => {
      if (counting.on) counting.counts.encodedBytes += bytes;
    },
  });
  boundStore = env.store;
  boundPath = env.dbPath;
  const saver = env.enqueue('Save notes', { history: 'fresh' });
  const saverClaim = env.seed(
    saver.id,
    Array.from({ length: MEMORIES }, (_unused, index): RunEventPayload => ({ type: 'tool.call', callId: `save_${index}`, providerCallId: `save_${index}`, name: 'MemorySave', kind: 'other', title: 'save', rawInput: {} })),
    'hold',
  );
  const memoryIds = Array.from({ length: MEMORIES }, (_unused, index) =>
    env.store.memories.save({ origin: 'trusted', scope: 'user', project: null, text: `note ${index} zorpWord${index} 設定ファイル${index}`, runId: saver.id, step: 1, callId: `save_${index}` }).memory.id,
  );
  expect((await env.store.transition(saverClaim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
  env.clock.advance(1);
  const run = env.enqueue('Work through the logs', { history: 'fresh' });
  const middle = Math.floor(steps / 2);
  const events: RunEventPayload[] = [
    { type: 'run.started', attempt: 1, now: env.clock.now(), pins: {}, mode: 'default' },
    { type: 'context.memories_loaded', memories: memoryIds.map((id) => ({ id, status: 'unbound' as const })) },
  ];
  for (let step = 1; step <= steps; step += 1) {
    events.push(...stepEvents(step));
    if (step === middle) events.push({ type: 'context.compacted', item: { type: 'message', role: 'user', content: 'summary' }, summary: 'summary', replacedThroughSeq: 1 + 2 * middle });
  }
  const claim = env.seed(run.id, events, 'hold');
  const state = env.store.readRunEvents(run.id, 0, 100_000).reduce(foldRunState, initialRunState({ runId: run.id, sessionId: run.sessionId }));
  expect(env.store.writeSnapshot(claim, state.lastSeq, state).kind).toBe('ok');

  counting.on = true;
  const result = await env.store.transition(claim, ['RUNNING'], 'COMPLETED');
  counting.on = false;

  expect(result.kind).toBe('ok');
  if (path === 'thread') {
    const [contribution] = env.ofType(run.id, 'context.contribution');
    expect(contribution?.items.filter((item) => item.kind === 'memory' && item.contributed).length).toBe(MEMORIES);
  }
  return counting.counts;
};

describe('the loop share of a terminal transition, as counts (P9, design section 7)', () => {
  it('decodes no journal payload on the main thread and encodes the same bytes at 100, 150 and 200 steps, every memory cited at each size, when the journal thread measures', async () => {
    const counts: Counts[] = [];
    for (const steps of SIZES) counts.push(await terminalCounts(steps, 'thread'));

    expect(counts.map((count) => [count.decodedRows, count.decodedBytes])).toEqual(SIZES.map(() => [0, 0]));
    expect(new Set(counts.map((count) => count.encodedBytes)).size).toBe(1);
    expect(counts[0]?.encodedBytes ?? 0).toBeGreaterThan(0);
  }, LARGE_RUN_SETUP_TEST_TIMEOUT_MS);

  it('control: an inline preparer that reads through the store decodes on the main thread, and the count grows with the run', async () => {
    const counts: Counts[] = [];
    for (const steps of SIZES) counts.push(await terminalCounts(steps, 'inline'));

    expect(counts[0]?.decodedRows ?? 0).toBeGreaterThan(0);
    for (let index = 1; index < counts.length; index += 1) {
      expect(counts[index]?.decodedRows ?? 0).toBeGreaterThan(counts[index - 1]?.decodedRows ?? 0);
      expect(counts[index]?.decodedBytes ?? 0).toBeGreaterThan(counts[index - 1]?.decodedBytes ?? 0);
    }
  }, LARGE_RUN_SETUP_TEST_TIMEOUT_MS);
});
