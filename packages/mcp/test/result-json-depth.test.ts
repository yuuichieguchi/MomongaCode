import { describe, expect, it } from 'vitest';
import { JsonDepthError, MAX_JSON_DEPTH } from '@momonga/foundation';
import { MIN_TASK_POLL_MS, parseInputRequests } from '@momonga/mcp';
import { createFakeClock } from '@momonga/testkit';
import { makeRemoteConnection, observedTimers, startHttpFixture, textOf } from './remote-harness.ts';

const nestedArrays = (depth: number): unknown => {
  let value: unknown[] = [];
  for (let level = 1; level < depth; level += 1) value = [value];
  return value;
};

const structuredOfDepth = (depth: number): Record<string, unknown> => ({ n: 2, extra: nestedArrays(depth - 1) });

const completedTaskCall = async (structuredContent: unknown): Promise<{ outcome: Promise<unknown> }> => {
  const fixture = await startHttpFixture({ era: 'modern', taskPollIntervalMs: 1 });
  const timers = observedTimers(createFakeClock(1_000_000));
  const { connection } = makeRemoteConnection({ fixture, timers });
  await connection.listTools();
  const scheduled = timers.nextScheduled((ms) => ms === MIN_TASK_POLL_MS);
  const outcome = connection.callTool({ name: 'structured_task', arguments: {}, timeoutMs: 1_000_000 });
  outcome.catch(() => undefined);
  await scheduled;
  fixture.completeTask(fixture.taskIds()[0] as string, 'task result', structuredContent);
  timers.advance(MIN_TASK_POLL_MS);
  return { outcome };
};

describe('MCP tool results and the one JSON depth bound', () => {
  it('builds structured content whose depth is the depth under test', () => {
    expect(JSON.stringify(structuredOfDepth(3))).toBe('{"n":2,"extra":[[]]}');
  });

  it(`accepts a tool result nested exactly ${MAX_JSON_DEPTH} deep`, async () => {
    const { outcome } = await completedTaskCall(structuredOfDepth(MAX_JSON_DEPTH));
    expect(textOf((await outcome) as { content?: unknown })).toBe('task result');
  });

  it(`refuses a tool result nested ${MAX_JSON_DEPTH + 1} deep with the typed depth error`, async () => {
    const { outcome } = await completedTaskCall(structuredOfDepth(MAX_JSON_DEPTH + 1));
    const error = await outcome.then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(JsonDepthError);
    expect((error as Error).message).toMatch(/depth/i);
    expect((error as Error).message).toContain(String(MAX_JSON_DEPTH));
  });
});

const inputRequestsOfDepth = (depth: number): Record<string, unknown> => ({
  who: {
    method: 'elicitation/create',
    params: { message: 'Name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } }, _meta: nestedArrays(depth - 3) },
  },
});

const thrownBy = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
};

describe('MCP input requests and the one JSON depth bound', () => {
  it('builds input requests whose depth is the depth under test', () => {
    expect(JSON.stringify(inputRequestsOfDepth(5)['who'])).toContain('"_meta":[[]]');
  });

  it(`accepts an input request nested exactly ${MAX_JSON_DEPTH} deep`, () => {
    expect(parseInputRequests(inputRequestsOfDepth(MAX_JSON_DEPTH))).toMatchObject([{ key: 'who', mode: 'form', message: 'Name?' }]);
  });

  it(`refuses an input request nested ${MAX_JSON_DEPTH + 1} deep with the typed depth error`, () => {
    const error = thrownBy(() => parseInputRequests(inputRequestsOfDepth(MAX_JSON_DEPTH + 1)));
    expect(error).toBeInstanceOf(JsonDepthError);
    expect((error as Error).message).toContain(String(MAX_JSON_DEPTH));
  });
});
