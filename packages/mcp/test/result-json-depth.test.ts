import { describe, expect, it } from 'vitest';
import { MAX_JSON_DEPTH } from '@momonga/foundation';
import { McpInputSuspension } from '@momonga/mcp';
import { nestedArraysJsonText, nestedNotJsonText } from '@momonga/testkit';
import { NEVER_ABORTED } from './mcp-harness.ts';
import { makeRemoteConnection, startHttpFixture, textOf } from './remote-harness.ts';

const STACK_BREAKING_NESTING = 10_000;

const RESULT_META_WRAPPING = 3;
const NOTIFICATION_DATA_WRAPPING = 2;
const LIST_SCHEMA_WRAPPING = 4;
const ELICITATION_META_WRAPPING = 5;

const outcomeOf = <T>(promise: Promise<T>): Promise<{ value: T } | { error: unknown }> =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

const causesOf = (error: unknown): unknown[] => {
  const chain: unknown[] = [];
  for (let current = error; current !== undefined && chain.length < 32; current = (current as { cause?: unknown }).cause) chain.push(current);
  return chain;
};

const expectDepthRefusal = (error: unknown): void => {
  expect(error).toBeInstanceOf(Error);
  expect(causesOf(error).some((link) => link instanceof RangeError)).toBe(false);
  expect((error as Error).message).toMatch(/depth/i);
  expect((error as Error).message).toContain(String(MAX_JSON_DEPTH));
};

describe('the deep values the fixture sends', () => {
  it('builds a not chain whose JSON depth is its nesting', () => {
    expect(nestedNotJsonText(1)).toBe('{"type":"object"}');
    expect(nestedNotJsonText(3)).toBe('{"type":"object","not":{"not":{}}}');
    expect(nestedArraysJsonText(2)).toBe('[[]]');
  });
});

describe('MCP responses are measured once, at the message that enters', () => {
  const deepResult = async (messageDepth: number) => {
    const fixture = await startHttpFixture({ era: 'modern', deepTools: {} });
    const { connection } = makeRemoteConnection({ fixture });
    await connection.listTools();
    return outcomeOf(connection.callTool({ name: 'deep_result', arguments: { nesting: messageDepth - RESULT_META_WRAPPING }, signal: NEVER_ABORTED }));
  };

  it(`returns a tools/call response that is exactly ${MAX_JSON_DEPTH} deep`, async () => {
    const outcome = await deepResult(MAX_JSON_DEPTH);
    expect('value' in outcome && textOf(outcome.value)).toBe('deep result');
  });

  it(`fails the call when its response is ${MAX_JSON_DEPTH + 1} deep, naming the depth`, async () => {
    const outcome = await deepResult(MAX_JSON_DEPTH + 1);
    expect('error' in outcome).toBe(true);
    if ('error' in outcome) expectDepthRefusal(outcome.error);
  });
});

describe('MCP notifications are measured at the message that enters', () => {
  const callWithNotification = async (notificationDepth: number) => {
    const notices: string[] = [];
    const fixture = await startHttpFixture({ era: 'modern', deepTools: {} });
    const { connection } = makeRemoteConnection({ fixture, connection: { onNotice: (message: string) => notices.push(message) } });
    await connection.listTools();
    const outcome = await outcomeOf(
      connection.callTool({ name: 'deep_result', arguments: { nesting: 1, notifyNesting: notificationDepth - NOTIFICATION_DATA_WRAPPING }, signal: NEVER_ABORTED }),
    );
    return { notices, outcome };
  };

  it(`keeps a notification exactly ${MAX_JSON_DEPTH} deep without a notice`, async () => {
    const { notices, outcome } = await callWithNotification(MAX_JSON_DEPTH);
    expect('value' in outcome && textOf(outcome.value)).toBe('deep result');
    expect(notices.filter((notice) => /depth/i.test(notice))).toEqual([]);
  });

  it(`drops a notification ${MAX_JSON_DEPTH + 1} deep with a notice naming the server and the depth, and the call still completes`, async () => {
    const { notices, outcome } = await callWithNotification(MAX_JSON_DEPTH + 1);
    expect('value' in outcome && textOf(outcome.value)).toBe('deep result');
    const depthNotices = notices.filter((notice) => /depth/i.test(notice));
    expect(depthNotices).toHaveLength(1);
    expect(depthNotices[0]).toContain('remote');
    expect(depthNotices[0]).toContain(String(MAX_JSON_DEPTH));
  });
});

describe('a tools/list reply is measured as one message', () => {
  const listing = async (schemaNesting: number) => {
    const fixture = await startHttpFixture({ era: 'modern', deepTools: { outputSchemaNesting: schemaNesting } });
    const { connection } = makeRemoteConnection({ fixture });
    return outcomeOf(connection.listTools());
  };

  it(`lists every tool when the reply is exactly ${MAX_JSON_DEPTH} deep`, async () => {
    const outcome = await listing(MAX_JSON_DEPTH - LIST_SCHEMA_WRAPPING);
    expect('value' in outcome).toBe(true);
    if (!('value' in outcome)) return;
    const names = (outcome.value as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toContain('deep_output');
    expect(names).toContain('echo');
  });

  it(`fails the whole listing when one outputSchema makes the reply ${MAX_JSON_DEPTH + 1} deep`, async () => {
    const outcome = await listing(MAX_JSON_DEPTH + 1 - LIST_SCHEMA_WRAPPING);
    expect('error' in outcome).toBe(true);
    if ('error' in outcome) expectDepthRefusal(outcome.error);
  });

  it(`refuses a ${STACK_BREAKING_NESTING}-deep outputSchema at the message without any stack overflow`, async () => {
    const outcome = await listing(STACK_BREAKING_NESTING);
    expect('error' in outcome).toBe(true);
    if ('error' in outcome) expectDepthRefusal(outcome.error);
  });
});

describe('an elicitation input request is measured with the message that carries it', () => {
  const elicitation = async (messageDepth: number) => {
    const fixture = await startHttpFixture({ era: 'modern', deepTools: { elicitationMetaNesting: messageDepth - ELICITATION_META_WRAPPING } });
    const { connection } = makeRemoteConnection({ fixture });
    await connection.listTools();
    return outcomeOf(connection.callTool({ name: 'mrtr_elicit', arguments: {}, signal: NEVER_ABORTED }));
  };

  it(`hands back an input request whose message is exactly ${MAX_JSON_DEPTH} deep`, async () => {
    const outcome = await elicitation(MAX_JSON_DEPTH);
    expect('error' in outcome && outcome.error).toBeInstanceOf(McpInputSuspension);
  });

  it(`fails the call when the message carrying the input request is ${MAX_JSON_DEPTH + 1} deep, naming the depth`, async () => {
    const outcome = await elicitation(MAX_JSON_DEPTH + 1);
    expect('error' in outcome).toBe(true);
    if (!('error' in outcome)) return;
    expect(outcome.error).not.toBeInstanceOf(McpInputSuspension);
    expectDepthRefusal(outcome.error);
  });
});
