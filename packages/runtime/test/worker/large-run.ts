import type { RunEventPayload, RunState } from '@momonga/protocol';
import { pinnedDigestOf } from '@momonga/runtime';
import { foldRunState, initialRunState } from '@momonga/store';
import type { Claim, Run } from '@momonga/store';
import type { Env } from './harness.ts';
import { functionCallItem } from './scripts.ts';

export const OUTPUT_CHARS = 30_000;
export const MEMORIES = 40;
const HISTORY_IN_REQUEST = 8;
const TOOL_COUNT = 30;
const SEED_CHUNK_STEPS = 25;
const FOLD_CHUNK_EVENTS = 200;

const ascii = (seed: number): string =>
  Array.from({ length: Math.ceil(OUTPUT_CHARS / 2 / 52) }, (_unused, line) => `line-${String(seed * 1000 + line).padStart(7, '0')} src/module${seed}/file${line}.ts handler`).join('\n').slice(0, OUTPUT_CHARS / 2);

const japanese = (seed: number): string =>
  Array.from({ length: Math.ceil(OUTPUT_CHARS / 2 / 20) }, (_unused, line) => `設定ファイル${seed}の読み込み${line}に失敗しました。`).join('\n').slice(0, OUTPUT_CHARS / 2);

const outputs = new Map<number, string>();

export const outputOf = (step: number): string => {
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

export const stepEvents = (step: number): RunEventPayload[] => {
  const callId = `call_${step}`;
  const args = { value: `step ${step} zorpWord${step % MEMORIES}` };
  return [
    requestOf(step),
    { type: 'model.responded', step, attempt: 1, response: { status: 'completed', output: [functionCallItem({ callId, name: 'Echo', args })], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    { type: 'tool.call', callId, providerCallId: callId, name: 'Echo', kind: 'read', title: 'Echo', rawInput: args },
    { type: 'tool.completed', callId, status: 'completed', output: outputOf(step) },
  ];
};

export type LargeRun = { run: Run; claim: Claim; memoryIds: string[] };

const savedMemories = async (env: Env): Promise<string[]> => {
  const saver = env.enqueue('Save notes', { history: 'fresh' });
  const saverClaim = await env.seed(
    saver.id,
    Array.from({ length: MEMORIES }, (_unused, index): RunEventPayload => ({ type: 'tool.call', callId: `save_${index}`, providerCallId: `save_${index}`, name: 'MemorySave', kind: 'other', title: 'save', rawInput: {} })),
    'hold',
  );
  const memoryIds: string[] = [];
  for (let index = 0; index < MEMORIES; index += 1) {
    memoryIds.push((await env.store.memories.save({ origin: 'trusted', scope: 'user', project: null, text: `note ${index} zorpWord${index} 設定ファイル${index}`, runId: saver.id, step: 1, callId: `save_${index}` })).memory.id);
  }
  const finished = await env.store.transition(saverClaim, ['RUNNING'], 'COMPLETED');
  if (finished.kind !== 'ok') throw new Error(`the run that saves the memories could not complete: ${finished.kind}`);
  return memoryIds;
};

export const seedLargeRun = async (env: Env, steps: number): Promise<LargeRun> => {
  const memoryIds = await savedMemories(env);
  env.clock.advance(1);
  const run = env.enqueue('Work through the logs', { history: 'fresh' });
  const middle = Math.floor(steps / 2);
  const claim = await env.seed(
    run.id,
    [
      { type: 'run.started', attempt: 1, now: env.clock.now(), pins: {}, mode: 'manual' },
      { type: 'context.memories_loaded', memories: memoryIds.map((id) => ({ id, status: 'unbound' as const })) },
    ],
    'hold',
  );
  for (let from = 1; from <= steps; from += SEED_CHUNK_STEPS) {
    const chunk: RunEventPayload[] = [];
    for (let step = from; step < from + SEED_CHUNK_STEPS && step <= steps; step += 1) {
      chunk.push(...stepEvents(step));
      if (step === middle) chunk.push({ type: 'context.compacted', item: { type: 'message', role: 'user', content: 'summary' }, summary: 'summary', replacedThroughSeq: 1 + 2 * middle });
    }
    const appended = env.store.append(claim, chunk);
    if (appended.kind !== 'ok') throw new Error(`the large run could not be seeded: ${appended.kind}`);
  }
  return { run, claim, memoryIds };
};

export const foldedThrough = (env: Env, run: Run, throughSeq: number): RunState => {
  let state = initialRunState({ runId: run.id, sessionId: run.sessionId });
  while (state.lastSeq < throughSeq) {
    const events = env.store.readRunEvents(run.id, state.lastSeq, Math.min(FOLD_CHUNK_EVENTS, throughSeq - state.lastSeq));
    if (events.length === 0) throw new Error(`run ${run.id} has no event after seq ${state.lastSeq}`);
    state = events.reduce(foldRunState, state);
  }
  return state;
};
