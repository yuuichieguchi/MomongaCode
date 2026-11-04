import { describe, expect, it } from 'vitest';
import { TOOL_USAGE_WINDOW_RUNS } from '@momonga/memory';
import type { RunEventPayload } from '@momonga/protocol';
import { readRunLimits } from '../../src/worker/limits.ts';
import { toolUsageWindowOf } from '../../src/worker/tool-usage-window.ts';
import { DEADLINE_MS, createdRun, makeEnv } from './harness.ts';
import { LARGE_RUN_SETUP_TEST_TIMEOUT_MS, PAUSE_BUDGET_MS, threadCpuMillisOf } from './pause-budget.ts';
const STEPS = readRunLimits({}).maxSteps;
const LOG_CHARS = 8_000;
const HISTORY_IN_REQUEST = 8;
const TOOL_COUNT = 30;

const SYSTEM_PROMPT = Array.from({ length: 120 }, (_unused, line) => `Rule ${line}: keep the change small and verify it before you answer.`).join('\n');
const TOOLS = Array.from({ length: TOOL_COUNT }, (_unused, index) => ({
  type: 'function',
  name: `Tool${String(index).padStart(2, '0')}`,
  description: `Tool number ${index} reads or changes something in the workspace and reports what it found. `.repeat(8),
  parameters: { type: 'object', properties: { file_path: { type: 'string', description: 'absolute path of the file' } } },
}));

const outputOf = (step: number): string => {
  const ascii = `line ${step} src/module/file.ts handler `.repeat(Math.ceil(LOG_CHARS / 2 / 32)).slice(0, LOG_CHARS / 2);
  const japanese = `設定ファイル${step}の読み込みに失敗しました。`.repeat(Math.ceil(LOG_CHARS / 2 / 18)).slice(0, LOG_CHARS / 2);
  return `${ascii}\n${japanese}`;
};

const requestOf = (step: number): RunEventPayload => ({
  type: 'model.requested',
  step,
  attempt: 1,
  digest: `digest-${step}`,
  body: {
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
  },
});

const runEvents = (now: number): RunEventPayload[] => [
  { type: 'run.started', attempt: 1, now, pins: {}, mode: 'default' },
  ...Array.from({ length: STEPS }, (_unused, index) => index + 1).flatMap((step): RunEventPayload[] => [
    requestOf(step),
    { type: 'tool.call', callId: `call_${step}`, providerCallId: `call_${step}`, name: 'Tool00', kind: 'read', title: 'Tool00', rawInput: {} },
  ]),
];

describe('the cost of the tool usage window at root run start (open item 8)', () => {
  it('reads the request bodies of the window runs within the pause budget of run start', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    let bodyBytes = 0;
    for (let index = 0; index < TOOL_USAGE_WINDOW_RUNS; index += 1) {
      env.clock.advance(1);
      const run = createdRun(env.store.createRunAndEnqueue(env.session.id, { input: 'Past work', timeoutMs: DEADLINE_MS - env.clock.now(), limits: {}, pins: {}, history: 'fresh' }));
      const events = runEvents(env.clock.now());
      bodyBytes += events.reduce((sum, event) => sum + (event.type === 'model.requested' ? Buffer.byteLength(JSON.stringify(event.body)) : 0), 0);
      const claim = env.seed(run.id, events, 'hold');
      expect(env.store.transition(claim, ['RUNNING'], 'COMPLETED').kind).toBe('ok');
    }

    const { value: window, millis } = await threadCpuMillisOf(() => toolUsageWindowOf(env.store, env.session.cwd));

    console.info(`${TOOL_USAGE_WINDOW_RUNS} runs of ${STEPS} requests, ${bodyBytes} body bytes: tool usage window ${millis.toFixed(1)} ms of thread CPU time`);
    expect(window).toHaveLength(TOOL_USAGE_WINDOW_RUNS);
    expect(window[0]).toEqual({ offered: TOOLS.map((tool) => tool.name), called: ['Tool00'] });
    expect(millis).toBeLessThan(PAUSE_BUDGET_MS);
  }, LARGE_RUN_SETUP_TEST_TIMEOUT_MS);
});
