import { describe, expect, it } from 'vitest';
import { TOOL_USAGE_WINDOW_RUNS } from '@momonga/memory';
import type { RunEventPayload } from '@momonga/protocol';
import { readRunLimits } from '../../src/worker/limits.ts';
import { toolUsageWindowOf } from '../../src/worker/tool-usage-window.ts';
import { TOOL_OFFERED, bodyWatchedStore } from './body-watched-store.ts';
import { DEADLINE_MS, createdRun, makeEnv } from './harness.ts';
import { LARGE_RUN_SETUP_TEST_TIMEOUT_MS } from './pause-budget.ts';
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

const offeredRecord = { type: TOOL_OFFERED, names: TOOLS.map((tool) => tool.name) } as unknown as RunEventPayload;

const runEvents = (now: number): RunEventPayload[] => [
  { type: 'run.started', attempt: 1, now, pins: {}, mode: 'manual' },
  offeredRecord,
  ...Array.from({ length: STEPS }, (_unused, index) => index + 1).flatMap((step): RunEventPayload[] => [
    requestOf(step),
    { type: 'tool.call', callId: `call_${step}`, providerCallId: `call_${step}`, name: 'Tool00', kind: 'read', title: 'Tool00', rawInput: {} },
  ]),
];

describe('the cost of the tool usage window at root run start (person item 9)', () => {
  it('reads one offered-names record per window run and decodes no request body on the main thread', async () => {
    const counting = { on: false, rows: 0, bytes: 0 };
    const env = await makeEnv({
      mode: 'bypassPermissions',
      onDecode: (rows, bytes) => {
        if (!counting.on) return;
        counting.rows += rows;
        counting.bytes += bytes;
      },
    });
    let bodyBytes = 0;
    for (let index = 0; index < TOOL_USAGE_WINDOW_RUNS; index += 1) {
      env.clock.advance(1);
      const run = await createdRun(await env.store.createRunAndEnqueue(env.session.id, { input: 'Past work', timeoutMs: DEADLINE_MS - env.clock.now(), limits: {}, pins: {}, history: 'fresh' }));
      const events = runEvents(env.clock.now());
      bodyBytes += events.reduce((sum, event) => sum + (event.type === 'model.requested' ? Buffer.byteLength(JSON.stringify(event.body)) : 0), 0);
      const claim = await env.seed(run.id, events, 'hold');
      expect((await env.store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
    }

    const { store, reads } = bodyWatchedStore(env.store);

    counting.on = true;
    const window = await toolUsageWindowOf(store, env.session.cwd);
    counting.on = false;

    expect(reads.bodyReads).toEqual([]);
    expect(reads.eventsReturned).toBeLessThanOrEqual(TOOL_USAGE_WINDOW_RUNS);
    expect(window).toHaveLength(TOOL_USAGE_WINDOW_RUNS);
    expect(window[0]).toEqual({ offered: TOOLS.map((tool) => tool.name), called: ['Tool00'] });
    expect(counting.rows).toBeLessThanOrEqual(TOOL_USAGE_WINDOW_RUNS);
    expect(counting.bytes).toBeLessThan(bodyBytes / (TOOL_USAGE_WINDOW_RUNS * STEPS));
  }, LARGE_RUN_SETUP_TEST_TIMEOUT_MS);
});
