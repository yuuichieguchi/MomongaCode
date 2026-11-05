import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIN_ROOM_TOKENS, budgetFor, inputCeilingFor } from '@momonga/context';
import { ESTIMATED_ERROR_SHAPE, errorBoundOfShape } from '@momonga/protocol';
import type { Capabilities } from '@momonga/protocol';
import { DAEMON_PROCESS_TEST_TIMEOUT_MS, countFakeRequestTokens } from '@momonga/testkit';
import type { FakeFixedUsage } from '@momonga/testkit';
import { finishApprovingPrompts, launchRuntime, prepareStack, readDb, scriptedToolCall, startGateway } from './run-helpers.ts';

const PROCESS_TIMEOUT = { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS };
const WINDOW = 4096;
const OUTPUT = 1024;

const reportAtDeclaredBound = (body: unknown): FakeFixedUsage => {
  const estimated = countFakeRequestTokens(body);
  const prompt = estimated + errorBoundOfShape(ESTIMATED_ERROR_SHAPE, estimated);
  return { prompt_tokens: prompt, completion_tokens: 5, total_tokens: prompt + 5 };
};

const finalText = (text: string) => ({ kind: 'stream' as const, chunks: [{ delta: { role: 'assistant', content: text }, finishReason: 'stop' }], usage: reportAtDeclaredBound });

type EventRow = { type: string; payload_json: string };

const payloadsOf = (rows: readonly EventRow[], type: string): Record<string, any>[] =>
  rows.filter((row) => row.type === type).map((row) => JSON.parse(row.payload_json) as Record<string, any>);

describe('the pinned part admitted at run start, after the server reports it within the estimator bound (LM Studio lms-3/4/5)', () => {
  it('a run whose first request is reported at the estimator bound, with room left in the input budget, keeps its offer and completes', PROCESS_TIMEOUT, async () => {
    const stack = await prepareStack((temp) => ({
      contextWindow: WINDOW,
      script: [
        scriptedToolCall('Read', { file_path: path.join(temp.project, 'notes.txt') }, 'call_1', reportAtDeclaredBound),
        scriptedToolCall('Read', { file_path: path.join(temp.project, 'notes.txt') }, 'call_2', reportAtDeclaredBound),
        finalText('done'),
      ],
    }));
    stack.settings({
      models: {
        aliases: { default: ['primary'] },
        targets: {
          primary: { adapter: 'chat-completions', provider: 'fake', model: 'system', socketPath: stack.fake.socketPath, capabilities: { contextWindow: WINDOW, maxOutputTokens: OUTPUT } },
        },
      },
    });
    await startGateway(stack.temp);
    fs.writeFileSync(path.join(stack.temp.project, 'notes.txt'), 'remember this\n');
    const launched = await launchRuntime(stack.temp);
    const session = await launched.createSession();
    const run = await launched.createRun(session.id, { input: 'Read the notes' });
    const status = await finishApprovingPrompts(launched, stack.temp, run.id);
    const rows = readDb<EventRow>(stack.temp.paths.databases.runtime, 'SELECT type, payload_json FROM events WHERE run_id = ? ORDER BY seq', run.id);
    const capabilities = payloadsOf(rows, 'run.started')[0]?.['pins']['capabilities'] as Capabilities;
    const ceiling = inputCeilingFor(capabilities);
    const [firstObserved] = payloadsOf(rows, 'meter.observed');
    expect(firstObserved).toMatchObject({ itemCount: 2, miss: 0 });
    expect(firstObserved?.['counted']).toBeLessThanOrEqual(ceiling - MIN_ROOM_TOKENS);
    expect(firstObserved?.['reported'] + MIN_ROOM_TOKENS).toBeLessThanOrEqual(budgetFor(capabilities, 0).I);
    expect(firstObserved?.['reported']).toBeGreaterThan(ceiling - MIN_ROOM_TOKENS);

    expect((await launched.http('GET', `/v1/runs/${run.id}`)).json.run.error).toBeUndefined();
    expect(status).toBe('COMPLETED');
    const offers = payloadsOf(rows, 'model.requested').map((payload) => (payload['body']['tools'] as { name: string }[]).map((tool) => tool.name));
    expect(offers).toHaveLength(3);
    expect(new Set(offers.map((names) => names.join(',')))).toHaveProperty('size', 1);
  });
});
