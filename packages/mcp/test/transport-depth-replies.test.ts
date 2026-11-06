import { describe, expect, it } from 'vitest';
import { MAX_JSON_DEPTH, createMemoryCredentialStore } from '@momonga/foundation';
import { createMcpPool } from '@momonga/mcp';
import { createToolRegistry } from '@momonga/tools';
import { createFakeClock } from '@momonga/testkit';
import { boundedMessages } from '../src/connection.ts';
import type { ConnectionTransport } from '../src/remote-transport.ts';
import { BASE_ENV, entry, makeDir, makeExecutor, onCleanup } from './mcp-harness.ts';
import { startHttpFixture } from './remote-harness.ts';

const nestedArrays = (depth: number): unknown => {
  let value: unknown[] = [];
  for (let level = 1; level < depth; level += 1) value = [value];
  return value;
};

const fakeTransport = () => {
  const sent: unknown[] = [];
  const transport = {
    onmessage: undefined as ((message: unknown) => void) | undefined,
    send: (message: unknown) => {
      sent.push(message);
      return Promise.resolve();
    },
  };
  return { transport, sent };
};

describe('a server message with an id is answered or failed through JSON-RPC', () => {
  const request = (depth: number, method: string) => ({ jsonrpc: '2.0', id: 7, method, params: { _meta: nestedArrays(depth - 2) } });

  it.each(['elicitation/create', 'sampling/createMessage'])('replies to a %s request past the bound with a JSON-RPC error for its id', (method) => {
    const { transport, sent } = fakeTransport();
    const notices: string[] = [];
    const delivered: unknown[] = [];
    const bounded = boundedMessages(transport as unknown as ConnectionTransport, 'remote', (notice) => notices.push(notice));
    bounded.onmessage = (message) => delivered.push(message);
    transport.onmessage?.(request(MAX_JSON_DEPTH + 1, method));
    expect(delivered).toEqual([]);
    expect(notices).toEqual([]);
    expect(sent).toHaveLength(1);
    const reply = sent[0] as { id: number; error: { message: string } };
    expect(reply.id).toBe(7);
    expect(reply.error.message).toMatch(/depth/i);
    expect(reply.error.message).toContain(String(MAX_JSON_DEPTH));
  });

  it('hands a request exactly at the bound to the SDK and sends nothing', () => {
    const { transport, sent } = fakeTransport();
    const delivered: unknown[] = [];
    const bounded = boundedMessages(transport as unknown as ConnectionTransport, 'remote', undefined);
    bounded.onmessage = (message) => delivered.push(message);
    transport.onmessage?.(request(MAX_JSON_DEPTH, 'elicitation/create'));
    expect(delivered).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  it('drops a notification past the bound with one notice and sends nothing', () => {
    const { transport, sent } = fakeTransport();
    const notices: string[] = [];
    const delivered: unknown[] = [];
    const bounded = boundedMessages(transport as unknown as ConnectionTransport, 'remote', (notice) => notices.push(notice));
    bounded.onmessage = (message) => delivered.push(message);
    transport.onmessage?.({ jsonrpc: '2.0', method: 'notifications/message', params: { data: nestedArrays(MAX_JSON_DEPTH) } });
    expect(delivered).toEqual([]);
    expect(sent).toEqual([]);
    expect(notices).toHaveLength(1);
  });
});

describe('a dropped notification reaches the notices of the tool source through the pool', () => {
  const noticesAfterNotification = async (notifyDepth: number) => {
    const fixture = await startHttpFixture({ era: 'modern', deepTools: {} });
    const clock = createFakeClock(1_000_000);
    const pool = createMcpPool({
      servers: [entry('remote', { type: 'http', url: fixture.url })],
      projectDir: makeDir(),
      baseEnv: BASE_ENV,
      clock,
      random: () => 0,
      remote: {
        credentials: createMemoryCredentialStore(),
        randomToken: () => 'random',
        openAuthorizationUrl: () => Promise.reject(new Error('no browser in this test')),
      },
    });
    onCleanup(() => pool.close());
    const registry = createToolRegistry();
    for (const source of pool.sources) registry.addSource(source);
    const first = await registry.snapshot();
    await makeExecutor(clock).resultOf(first, 'mcp__remote__deep_result', { nesting: 1, notifyNesting: notifyDepth - 2 });
    const second = await registry.snapshot();
    const third = await registry.snapshot();
    return { second, third };
  };

  it(`shows exactly one notice naming the server and the depth for a notification ${MAX_JSON_DEPTH + 1} deep, once`, async () => {
    const { second, third } = await noticesAfterNotification(MAX_JSON_DEPTH + 1);
    const depthNotices = second.notices.filter((notice) => /depth/i.test(notice));
    expect(depthNotices).toHaveLength(1);
    expect(depthNotices[0]).toContain('remote');
    expect(depthNotices[0]).toContain(String(MAX_JSON_DEPTH));
    expect(third.notices.filter((notice) => /depth/i.test(notice))).toEqual([]);
  });

  it(`shows no depth notice for a notification exactly ${MAX_JSON_DEPTH} deep`, async () => {
    const { second } = await noticesAfterNotification(MAX_JSON_DEPTH);
    expect(second.notices.filter((notice) => /depth/i.test(notice))).toEqual([]);
  });
});
