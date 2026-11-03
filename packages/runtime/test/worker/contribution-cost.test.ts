import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import { makeEnv } from './harness.ts';
import { functionCallItem } from './scripts.ts';

const PAUSE_BUDGET_MS = 100;
const OUTPUT_CHARS = 30_000;
const STEPS = 150;
const MEMORIES = 40;

const ascii = (seed: number): string =>
  Array.from({ length: Math.ceil(OUTPUT_CHARS / 2 / 52) }, (_unused, line) => `line-${String(seed * 1000 + line).padStart(7, '0')} src/module${seed}/file${line}.ts handler`).join('\n').slice(0, OUTPUT_CHARS / 2);

const japanese = (seed: number): string =>
  Array.from({ length: Math.ceil(OUTPUT_CHARS / 2 / 20) }, (_unused, line) => `設定ファイル${seed}の読み込み${line}に失敗しました。`).join('\n').slice(0, OUTPUT_CHARS / 2);

const stepEvents = (step: number): RunEventPayload[] => {
  const callId = `call_${step}`;
  const args = { value: `step ${step} zorpWord${step % MEMORIES}` };
  return [
    { type: 'model.responded', step, attempt: 1, response: { status: 'completed', output: [functionCallItem({ callId, name: 'Echo', args })], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    { type: 'tool.call', callId, providerCallId: callId, name: 'Echo', kind: 'read', title: 'Echo', rawInput: args },
    { type: 'tool.completed', callId, status: 'completed', output: `${ascii(step)}\n${japanese(step)}` },
  ];
};

const terminalMillis = async (snapshotFirst: boolean): Promise<{ elapsed: number; prepareMillis: number; bytes: number }> => {
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
      events.push(...stepEvents(step));
      if (step === middle) events.push({ type: 'context.compacted', item: { type: 'message', role: 'user', content: 'summary' }, summary: 'summary', replacedThroughSeq: 1 + 2 * middle });
    }
    const claim = env.seed(run.id, events, 'hold');
    const bytes = events.reduce((sum, event) => sum + (event.type === 'tool.completed' ? Buffer.byteLength(event.output) : 0), 0);
    if (snapshotFirst) {
      const state = env.store.readRunEvents(run.id, 0, 100_000).reduce(foldRunState, initialRunState({ runId: run.id, sessionId: run.sessionId }));
      expect(env.store.writeSnapshot(claim, state.lastSeq, state).kind).toBe('ok');
    }

    const prepareStarted = performance.now();
    env.store.prepareTerminal(run.id);
    const prepareMillis = performance.now() - prepareStarted;
    const started = performance.now();
    const result = env.store.transition(claim, ['RUNNING'], 'COMPLETED');
    const elapsed = performance.now() - started;

    expect(result.kind).toBe('ok');
    const [contribution] = env.ofType(run.id, 'context.contribution');
    expect(contribution?.items.filter((item) => item.kind === 'memory' && item.contributed).length).toBe(MEMORIES);
    expect(contribution?.items).toContainEqual({ kind: 'working_state', id: 'working-state', contributed: false });
    return { elapsed, prepareMillis, bytes };
  }
};

describe('the cost of the contribution hook in the terminal transition', () => {
  it('stays within the pause budget for a worker terminal over a run at the output cap, half of it Japanese', async () => {
    const { elapsed, prepareMillis, bytes } = await terminalMillis(true);
    console.info(`worker terminal over ${bytes} output bytes: prepared outside the lock in ${prepareMillis.toFixed(1)} ms, transaction ${elapsed.toFixed(1)} ms`);
    expect(bytes).toBeGreaterThan(4_000_000);
    expect(elapsed).toBeLessThan(PAUSE_BUDGET_MS);
  });

  it('stays within the pause budget for a terminal over a journal with no snapshot', async () => {
    const { elapsed, prepareMillis, bytes } = await terminalMillis(false);
    console.info(`terminal without a snapshot over ${bytes} output bytes: prepared outside the lock in ${prepareMillis.toFixed(1)} ms, transaction ${elapsed.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(PAUSE_BUDGET_MS);
  });
});
