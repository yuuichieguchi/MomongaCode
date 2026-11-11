import { nodeFileSystem } from '@momonga/foundation';
import { describe, expect, it, vi } from 'vitest';
import { McpUnavailableError, createManagedConnection } from '@momonga/mcp';
import type { McpServerConnection } from '@momonga/mcp';
import { LEGACY_FIXTURE_PROTOCOL_VERSION, REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock } from '@momonga/testkit';
import type { FakeClock } from '@momonga/testkit';
import { outcomeOf, settledAfter } from './credential-store-fakes.ts';
import type { McpTimers } from '../src/timers.ts';
import { BASE_ENV, makeDir, onCleanup, waitUntil } from './mcp-harness.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const REQUEST_LIMIT_MS = 7_777_777;
const CONNECT_LIMIT_MS = 8_888_888;
const RESET_AFTER_MS = 60_000;
const FAILURES_THAT_OPEN = 3;

const serverScript = (onList: 'silent' | 'exit', onInitialize: 'answer' | 'silent'): string => `
const lines = require('node:readline').createInterface({ input: process.stdin });
const write = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    if (${JSON.stringify(onInitialize)} === 'answer') write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: ${JSON.stringify(LEGACY_FIXTURE_PROTOCOL_VERSION)}, capabilities: { tools: {} }, serverInfo: { name: 'availability-fixture', version: '1.0.0' } } });
    return;
  }
  if (message.method === 'tools/list') {
    process.stderr.write('list\\n');
    if (${JSON.stringify(onList)} === 'exit') process.exit(3);
    return;
  }
  write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found: ' + message.method } });
});
lines.on('close', () => process.exit(0));
`;

type HeldTimers = { timers: McpTimers; armed(ms: number): number; fire(ms: number): void };

const timersHolding = (held: readonly number[]): HeldTimers => {
  const pending = new Map<number, { ms: number; callback: () => void }>();
  let next = 0;
  return {
    timers: {
      setTimeout: (callback, ms) => {
        if (!held.includes(ms)) return setTimeout(callback, ms);
        next += 1;
        pending.set(next, { ms, callback });
        return next;
      },
      clearTimeout: (handle) => {
        if (typeof handle === 'number') pending.delete(handle);
        else clearTimeout(handle as NodeJS.Timeout);
      },
    },
    armed: (ms) => [...pending.values()].filter((timer) => timer.ms === ms).length,
    fire: (ms) => {
      for (const [handle, timer] of [...pending]) {
        if (timer.ms !== ms) continue;
        pending.delete(handle);
        timer.callback();
      }
    },
  };
};

type Fixture = { connection: McpServerConnection; held: HeldTimers; clock: FakeClock; listsSeen(): number };

const fixtureOf = (onList: 'silent' | 'exit', onInitialize: 'answer' | 'silent' = 'answer'): Fixture => {
  const held = timersHolding([REQUEST_LIMIT_MS, CONNECT_LIMIT_MS]);
  const clock = createFakeClock(1_000_000);
  const connection = createManagedConnection({ files: nodeFileSystem,
    clientVersion: '0.0.0-test',
    name: 's',
    config: { command: process.execPath, args: ['-e', serverScript(onList, onInitialize)] },
    scope: 'user',
    projectDir: makeDir(),
    baseEnv: BASE_ENV,
    clock,
    random: () => 0,
    timers: held.timers,
    requestTimeoutMs: REQUEST_LIMIT_MS,
    connectTimeoutMs: CONNECT_LIMIT_MS,
    resetAfterMs: RESET_AFTER_MS,
    closeGraceMs: 200,
  });
  onCleanup(() => connection.close());
  return { connection, held, clock, listsSeen: () => connection.diagnostics().stderrTail.split('\n').filter((line) => line === 'list').length };
};

const listEndedAtItsLimit = async ({ connection, held, listsSeen }: Fixture): Promise<Error> => {
  const before = listsSeen();
  const attempt = outcomeOf(connection.listTools());
  await waitUntil(() => listsSeen() === before + 1 && held.armed(REQUEST_LIMIT_MS) === 1, 'the server to receive tools/list under an armed request limit');
  held.fire(REQUEST_LIMIT_MS);
  await settledAfter(attempt);
  expect(attempt.state()).toBe('rejected');
  return attempt.error() as Error;
};

describe('every failure of an MCP server feeds its one availability breaker', () => {
  it('a server that connects and never answers tools/list is skipped once its request-limit failures reach the threshold, until the window passes', async () => {
    const fixture = fixtureOf('silent');
    const { connection, held, clock, listsSeen } = fixture;

    for (let failure = 0; failure < FAILURES_THAT_OPEN; failure += 1) {
      expect((await listEndedAtItsLimit(fixture)).message).toBe(`the request did not finish within the MCP request limit of ${REQUEST_LIMIT_MS} ms`);
    }

    const skipped = outcomeOf(connection.listTools());
    await settledAfter(skipped);
    expect(skipped.error()).toBeInstanceOf(McpUnavailableError);
    expect((skipped.error() as Error).message).toBe(`MCP server "s" is unavailable: the request did not finish within the MCP request limit of ${REQUEST_LIMIT_MS} ms`);
    expect(held.armed(REQUEST_LIMIT_MS)).toBe(0);
    expect(listsSeen()).toBe(FAILURES_THAT_OPEN);
    expect(connection.diagnostics().state).toBe('unavailable');

    clock.advance(RESET_AFTER_MS);
    await listEndedAtItsLimit(fixture);
    expect(listsSeen()).toBe(FAILURES_THAT_OPEN + 1);
    const skippedAgain = outcomeOf(connection.listTools());
    await settledAfter(skippedAgain);
    expect(skippedAgain.error()).toBeInstanceOf(McpUnavailableError);
  });

  it('a server whose process ends at every tools/list is skipped at the threshold although each reconnect succeeds', async () => {
    const { connection } = fixtureOf('exit');

    for (let failure = 0; failure < FAILURES_THAT_OPEN; failure += 1) {
      const attempt = outcomeOf(connection.listTools());
      await settledAfter(attempt);
      expect(attempt.state()).toBe('rejected');
      expect(attempt.error()).not.toBeInstanceOf(McpUnavailableError);
    }

    const skipped = outcomeOf(connection.listTools());
    await settledAfter(skipped);
    expect(skipped.error()).toBeInstanceOf(McpUnavailableError);
    expect((skipped.error() as Error).message).toContain('server exited with code 3');
  });

  it('a caller that aborts its own list is not counted as a failure of the server', async () => {
    const fixture = fixtureOf('silent');
    const { connection, held, listsSeen } = fixture;

    for (let round = 0; round < FAILURES_THAT_OPEN + 1; round += 1) {
      const controller = new AbortController();
      const attempt = outcomeOf(connection.listTools({ signal: controller.signal }));
      await waitUntil(() => listsSeen() === round + 1 && held.armed(REQUEST_LIMIT_MS) === 1, 'the server to receive tools/list');
      controller.abort(new Error('the run was cancelled'));
      await settledAfter(attempt);
      expect(attempt.error()).not.toBeInstanceOf(McpUnavailableError);
    }
    expect(connection.diagnostics().state).toBe('connected');
  });
});

describe('every wait inside an MCP tool call takes the signal of that call', () => {
  it('a call aborted while the connect is still pending ends at the abort with the reason of the abort', async () => {
    const { connection, held } = fixtureOf('silent', 'silent');
    const controller = new AbortController();
    const reason = new Error('the tool call was cancelled');

    const call = outcomeOf(connection.callTool({ name: 'echo', arguments: {}, signal: controller.signal }));
    await waitUntil(() => held.armed(CONNECT_LIMIT_MS) >= 1, 'the connect to be pending under its limit');
    controller.abort(reason);
    await settledAfter(call);

    expect(call.state()).toBe('rejected');
    expect(call.error()).toBe(reason);
    expect(held.armed(CONNECT_LIMIT_MS)).toBeGreaterThanOrEqual(1);
  });
});
