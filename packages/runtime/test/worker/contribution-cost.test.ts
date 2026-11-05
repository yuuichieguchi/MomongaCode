import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { pinnedDigestOf } from '@momonga/runtime';
import { foldRunState, initialRunState } from '@momonga/store';
import { makeEnv } from './harness.ts';
import { LARGE_RUN_SETUP_TEST_TIMEOUT_MS, PAUSE_BUDGET_MS, threadCpuMillisOf } from './pause-budget.ts';
import { functionCallItem } from './scripts.ts';

const OUTPUT_CHARS = 30_000;
const STEPS = 150;
const MEMORIES = 40;

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

const HISTORY_IN_REQUEST = 8;
const LARGE_HISTORY_IN_REQUEST = 27;
const TOOL_COUNT = 30;

const SYSTEM_PROMPT = Array.from({ length: 120 }, (_unused, line) => `Rule ${line}: keep the change small and verify it before you answer.`).join('\n');
const TOOLS = Array.from({ length: TOOL_COUNT }, (_unused, index) => ({
  type: 'function',
  name: `Tool${index}`,
  description: `Tool number ${index} reads or changes something in the workspace and reports what it found. `.repeat(8),
  parameters: { type: 'object', properties: { file_path: { type: 'string', description: 'absolute path of the file' } } },
}));

const requestOf = (step: number, historyInRequest: number): RunEventPayload => {
  const body = {
    model: 'fm',
    input: [
      { type: 'message', role: 'system', content: SYSTEM_PROMPT },
      { type: 'message', role: 'developer', content: 'Instruction file: prefer small commits.' },
      ...Array.from({ length: Math.min(historyInRequest, step - 1) }, (_unused, offset) => ({
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

const stepEvents = (step: number, historyInRequest: number): RunEventPayload[] => {
  const callId = `call_${step}`;
  const args = { value: `step ${step} zorpWord${step % MEMORIES}` };
  return [
    requestOf(step, historyInRequest),
    { type: 'model.responded', step, attempt: 1, response: { status: 'completed', output: [functionCallItem({ callId, name: 'Echo', args })], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    { type: 'tool.call', callId, providerCallId: callId, name: 'Echo', kind: 'read', title: 'Echo', rawInput: args },
    { type: 'tool.completed', callId, status: 'completed', output: outputOf(step) },
  ];
};

const terminalMillis = async (snapshotFirst: boolean, historyInRequest: number): Promise<{ elapsed: number; prepareMillis: number; bytes: number }> => {
  {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const saver = env.enqueue('Save notes', { history: 'fresh' });
    const saverClaim = env.seed(
      saver.id,
      Array.from({ length: MEMORIES }, (_unused, index): RunEventPayload => ({ type: 'tool.call', callId: `save_${index}`, providerCallId: `save_${index}`, name: 'MemorySave', kind: 'other', title: 'save', rawInput: {} })),
      'hold',
    );
    const memoryIds = Array.from({ length: MEMORIES }, (_unused, index) =>
      env.store.memories.save({ origin: 'trusted', scope: 'user', project: null, text: `note ${index} zorpWord${index} 設定ファイル${index}`, runId: saver.id, step: 1, callId: `save_${index}` }).memory.id,
    );
    expect(env.store.transition(saverClaim, ['RUNNING'], 'COMPLETED').kind).toBe('ok');
    env.clock.advance(1);
    const run = env.enqueue('Work through the logs', { history: 'fresh' });
    const middle = Math.floor(STEPS / 2);
    const events: RunEventPayload[] = [
      { type: 'run.started', attempt: 1, now: env.clock.now(), pins: {}, mode: 'default' },
      { type: 'context.memories_loaded', memories: memoryIds.map((id) => ({ id, status: 'unbound' as const })) },
    ];
    for (let step = 1; step <= STEPS; step += 1) {
      events.push(...stepEvents(step, historyInRequest));
      if (step === middle) events.push({ type: 'context.compacted', item: { type: 'message', role: 'user', content: 'summary' }, summary: 'summary', replacedThroughSeq: 1 + 2 * middle });
    }
    const claim = env.seed(run.id, events, 'hold');
    const bytes = events.reduce((sum, event) => sum + (event.type === 'tool.completed' ? Buffer.byteLength(event.output) : 0), 0);
    if (snapshotFirst) {
      const state = env.store.readRunEvents(run.id, 0, 100_000).reduce(foldRunState, initialRunState({ runId: run.id, sessionId: run.sessionId }));
      expect(env.store.writeSnapshot(claim, state.lastSeq, state).kind).toBe('ok');
    }

    const { millis: prepareMillis } = await threadCpuMillisOf(() => env.store.prepareTerminal(run.id));
    const { value: result, millis: elapsed } = await threadCpuMillisOf(() => env.store.transition(claim, ['RUNNING'], 'COMPLETED'));

    expect(result.kind).toBe('ok');
    const [contribution] = env.ofType(run.id, 'context.contribution');
    expect(contribution?.items.filter((item) => item.kind === 'memory' && item.contributed).length).toBe(MEMORIES);
    expect(contribution?.items).toContainEqual({ kind: 'working_state', id: 'working-state', contributed: false });
    return { elapsed, prepareMillis, bytes };
  }
};

describe('the cost of the contribution hook in the terminal transition', () => {
  it('stays within the pause budget for a worker terminal over a run at the output cap, half of it Japanese', async () => {
    const { elapsed, prepareMillis, bytes } = await terminalMillis(true, HISTORY_IN_REQUEST);
    console.info(`worker terminal over ${bytes} output bytes: prepared outside the lock in ${prepareMillis.toFixed(1)} ms, transaction ${elapsed.toFixed(1)} ms of thread CPU time`);
    expect(bytes).toBeGreaterThan(4_000_000);
    expect(elapsed).toBeLessThan(PAUSE_BUDGET_MS);
    expect(prepareMillis).toBeLessThan(PAUSE_BUDGET_MS);
  }, LARGE_RUN_SETUP_TEST_TIMEOUT_MS);

  it('stays within the pause budget for a terminal over a journal with no snapshot', async () => {
    const { elapsed, prepareMillis, bytes } = await terminalMillis(false, HISTORY_IN_REQUEST);
    console.info(`terminal without a snapshot over ${bytes} output bytes: prepared outside the lock in ${prepareMillis.toFixed(1)} ms, transaction ${elapsed.toFixed(1)} ms of thread CPU time`);
    expect(elapsed).toBeLessThan(PAUSE_BUDGET_MS);
    expect(prepareMillis).toBeLessThan(PAUSE_BUDGET_MS);
  }, LARGE_RUN_SETUP_TEST_TIMEOUT_MS);

  it('stays within the pause budget when every recorded request is 800 KB', async () => {
    const { elapsed, prepareMillis } = await terminalMillis(false, LARGE_HISTORY_IN_REQUEST);
    console.info(`terminal over requests of ${LARGE_HISTORY_IN_REQUEST * OUTPUT_CHARS} characters: prepared outside the lock in ${prepareMillis.toFixed(1)} ms, transaction ${elapsed.toFixed(1)} ms of thread CPU time`);
    expect(elapsed).toBeLessThan(PAUSE_BUDGET_MS);
    expect(prepareMillis).toBeLessThan(PAUSE_BUDGET_MS);
  }, LARGE_RUN_SETUP_TEST_TIMEOUT_MS);
});
