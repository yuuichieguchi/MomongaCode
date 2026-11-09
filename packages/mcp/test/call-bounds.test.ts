import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FakeClock } from '@momonga/testkit';
import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import { createMcpToolSource, MCP_TOOL_IDLE_TIMEOUT_MS, MCP_TOOL_TOTAL_TIMEOUT_MS, MIN_TASK_POLL_MS } from '@momonga/mcp';
import type { McpCallToolInput, McpServerConnection } from '@momonga/mcp';
import { createToolRegistry } from '@momonga/tools';
import type { AnyTool, ToolStop } from '@momonga/tools';
import { pollCeilingMs, pollDelayMs, settleTask } from '../src/tasks.ts';
import type { TaskRequester } from '../src/tasks.ts';
import type { McpTimers } from '../src/timers.ts';
import { makeExecutor } from './mcp-harness.ts';

const TOOL: Tool = { name: 'long_job', inputSchema: { type: 'object', properties: {} } };
const DONE: CallToolResult = { content: [{ type: 'text', text: 'job done' }] };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type FakeCall = (input: McpCallToolInput) => Promise<CallToolResult>;

const fakeConnection = (options: { transportKind: 'stdio' | 'network'; call?: FakeCall; cancelled?: Record<string, boolean> }): McpServerConnection & { calls: McpCallToolInput[] } => {
  const calls: McpCallToolInput[] = [];
  return {
    calls,
    name: 'jobs',
    transportKind: options.transportKind,
    protocolVersion: undefined,
    protocolEra: undefined,
    serverInfo: undefined,
    instructions: undefined,
    listTools: async () => [TOOL],
    callTool: async (input) => {
      calls.push(input);
      return (options.call ?? (async () => DONE))(input);
    },
    releaseCheckpoint: async () => undefined,
    cancelOutcome: (taskId) => {
      const known = options.cancelled?.[taskId];
      return known === undefined ? undefined : Promise.resolve(known);
    },
    redact: (text) => text,
    diagnostics: () => ({ server: 'jobs', state: 'connected', pgid: undefined, protocolVersion: undefined, lastError: null, stderrTail: '' }),
    close: async () => undefined,
  };
};

const toolOf = async (connection: McpServerConnection, settings: { toolIdleTimeoutMs?: number; toolTotalTimeoutMs?: number } = {}): Promise<AnyTool> => {
  const [tool] = await createMcpToolSource({ server: 'jobs', connection, ...settings }).list();
  if (tool === undefined) throw new Error('the fake server lists one tool');
  return tool;
};

const stopOf = (bound: ToolStop['bound'], ms: number, checkpoint?: Record<string, unknown>): ToolStop => ({ bound, ms, checkpoint });

describe('G2 test 8: the defaults are decision 8, from one constants file', () => {
  it('waits 5 minutes without progress on a network transport, 30 minutes on stdio, and 28 hours overall', () => {
    expect(MCP_TOOL_IDLE_TIMEOUT_MS).toEqual({ network: 300_000, stdio: 1_800_000 });
    expect(MCP_TOOL_TOTAL_TIMEOUT_MS).toBe(28 * 60 * 60 * 1000);
  });

  it.each([
    ['network', 300_000],
    ['stdio', 1_800_000],
  ] as const)('gives a %s tool the idle window of its transport and the overall limit, never the 60 s request timeout', async (transportKind, idle) => {
    const tool = await toolOf(fakeConnection({ transportKind }));
    expect(tool.idleTimeoutMs).toBe(idle);
    expect(tool.timeoutMs).toBe(MCP_TOOL_TOTAL_TIMEOUT_MS);
  });

  it('uses mcp.toolIdleTimeoutMs and mcp.toolTotalTimeoutMs for both transports when the user sets them', async () => {
    const tool = await toolOf(fakeConnection({ transportKind: 'stdio' }), { toolIdleTimeoutMs: 90_000, toolTotalTimeoutMs: 7_200_000 });
    expect(tool.idleTimeoutMs).toBe(90_000);
    expect(tool.timeoutMs).toBe(7_200_000);
  });

  it('turns the idle window off when mcp.toolIdleTimeoutMs is 0, keeping the overall limit', async () => {
    const tool = await toolOf(fakeConnection({ transportKind: 'network' }), { toolIdleTimeoutMs: 0 });
    expect(tool.idleTimeoutMs).toBeUndefined();
    expect(tool.timeoutMs).toBe(MCP_TOOL_TOTAL_TIMEOUT_MS);
  });
});

describe('G2: the call reports progress to the executor instead of extending itself to the run deadline', () => {
  it('passes reportProgress as onProgress, a poll ceiling of half the idle window, and no deadline-derived timeout', async () => {
    const connection = fakeConnection({ transportKind: 'network' });
    const harness = makeExecutor();
    const registry = createToolRegistry();
    registry.addSource(createMcpToolSource({ server: 'jobs', connection }));
    const result = await harness.resultOf(await registry.snapshot(), 'mcp__jobs__long_job', {});
    expect(result.output).toBe('job done');
    const [input] = connection.calls;
    expect(typeof input?.onProgress).toBe('function');
    expect(input?.pollCeilingMs).toBe(150_000);
    expect(input?.timeoutMs).toBeUndefined();
  });

  it('test 1: completes an ordinary call whose server reports progress more often than the idle window, for longer than one window', async () => {
    const connection = fakeConnection({
      transportKind: 'network',
      call: async (input) => {
        for (let index = 0; index < 8; index += 1) {
          await sleep(40);
          input.onProgress?.();
        }
        return DONE;
      },
    });
    const harness = makeExecutor();
    const registry = createToolRegistry();
    registry.addSource(createMcpToolSource({ server: 'jobs', connection, toolIdleTimeoutMs: 120 }));
    const result = await harness.resultOf(await registry.snapshot(), 'mcp__jobs__long_job', {});
    expect(result).toMatchObject({ status: 'completed', output: 'job done' });
  });

  it('test 2: ends a call with no progress at the idle window, with the idle text', async () => {
    const connection = fakeConnection({ transportKind: 'network', call: (input) => new Promise((resolve) => input.signal?.addEventListener('abort', () => resolve(DONE), { once: true })) });
    const harness = makeExecutor();
    const registry = createToolRegistry();
    registry.addSource(createMcpToolSource({ server: 'jobs', connection, toolIdleTimeoutMs: 120 }));
    const result = await harness.resultOf(await registry.snapshot(), 'mcp__jobs__long_job', {});
    expect(result.status).toBe('failed');
    expect(result.output).toBe(
      'MCP server "jobs" sent no response or progress for 120 ms, so the call to long_job was stopped. The server may have run it; check before repeating it. To wait longer, raise mcp.toolIdleTimeoutMs.',
    );
  });
});

describe('every stop of an MCP call uses the MCP stop text, whatever bound ended it (audit-unbounded-waits-2026-11-07.md, Settled at Stage C, rule 2)', () => {
  it('ends a call stopped by the run deadline with the MCP stop text, which says the server may have run it', async () => {
    const connection = fakeConnection({ transportKind: 'network', call: (input) => new Promise((resolve) => input.signal?.addEventListener('abort', () => resolve(DONE), { once: true })) });
    const harness = makeExecutor();
    const registry = createToolRegistry();
    registry.addSource(createMcpToolSource({ server: 'jobs', connection, toolIdleTimeoutMs: 0 }));
    const result = await harness.resultOf(await registry.snapshot(), 'mcp__jobs__long_job', {}, { deadlineAt: harness.clock.now() + 120 });
    expect(result.status).toBe('failed');
    expect(result.output).toBe('The call to long_job on MCP server "jobs" reached the run deadline after 120 ms and was stopped. The server may have run it; check before repeating it.');
  });

  it('names the run deadline in hours, and adds the outcome of tasks/cancel for a task', async () => {
    const tool = await toolOf(fakeConnection({ transportKind: 'network', cancelled: { 'task-1': true } }));
    expect(await tool.stopText?.(stopOf('deadline', 6 * 60 * 60 * 1000, { kind: 'task', taskId: 'task-1', answered: [] }))).toBe(
      'The call to long_job on MCP server "jobs" reached the run deadline after 6 hours and was stopped. The server may have run it; check before repeating it. The task was cancelled on the server.',
    );
  });
});

describe('G2: the English text of each stop', () => {
  it('names the idle window in minutes on a network transport and on stdio', async () => {
    const network = await toolOf(fakeConnection({ transportKind: 'network' }));
    expect(await network.stopText?.(stopOf('idle', 300_000))).toBe(
      'MCP server "jobs" sent no response or progress for 5 minutes, so the call to long_job was stopped. The server may have run it; check before repeating it. To wait longer, raise mcp.toolIdleTimeoutMs.',
    );
    const stdio = await toolOf(fakeConnection({ transportKind: 'stdio' }));
    expect(await stdio.stopText?.(stopOf('idle', 1_800_000))).toContain('for 30 minutes,');
  });

  it('names the overall limit in hours', async () => {
    const tool = await toolOf(fakeConnection({ transportKind: 'network' }));
    expect(await tool.stopText?.(stopOf('total', MCP_TOOL_TOTAL_TIMEOUT_MS))).toBe(
      'The call to long_job on MCP server "jobs" reached the overall limit of 28 hours and was stopped. The server may have run it; check before repeating it.',
    );
  });

  it('adds that the task was cancelled on the server only after tasks/cancel succeeded', async () => {
    const tool = await toolOf(fakeConnection({ transportKind: 'network', cancelled: { 'task-1': true } }));
    expect(await tool.stopText?.(stopOf('idle', 300_000, { kind: 'task', taskId: 'task-1', answered: [] }))).toBe(
      'MCP server "jobs" sent no response or progress for 5 minutes, so the call to long_job was stopped. The server may have run it; check before repeating it. To wait longer, raise mcp.toolIdleTimeoutMs. The task was cancelled on the server.',
    );
  });

  it('test 7: says the task may still be running when tasks/cancel failed', async () => {
    const tool = await toolOf(fakeConnection({ transportKind: 'network', cancelled: { 'task-1': false } }));
    expect(await tool.stopText?.(stopOf('total', MCP_TOOL_TOTAL_TIMEOUT_MS, { kind: 'task', taskId: 'task-1', answered: [] }))).toBe(
      'The call to long_job on MCP server "jobs" reached the overall limit of 28 hours and was stopped. The server may have run it; check before repeating it. The task could not be cancelled and may still be running on the server.',
    );
  });
});

const TASK_ID = 'task-1';
const accepted: CallToolResult = { content: [{ type: 'text', text: 'accepted' }] };

const recordingTimers = (delays: number[]): McpTimers => ({
  setTimeout: (callback, ms) => {
    delays.push(ms);
    queueMicrotask(callback);
    return undefined;
  },
  clearTimeout: () => undefined,
});

const settleWith = (views: unknown[], options: { pollCeilingMs?: number; onProgress?: () => void; delays?: number[] }) => {
  let index = 0;
  const request: TaskRequester = async (method) => {
    if (method !== 'tasks/get') return {};
    index += 1;
    return views[Math.min(index, views.length - 1)];
  };
  return settleTask({
    start: { created: views[0] },
    answers: {},
    request,
    timers: recordingTimers(options.delays ?? []),
    clock: { now: () => 1_000_000 },
    signal: new AbortController().signal,
    onCheckpoint: () => undefined,
    accept: async () => accepted,
    trackCancel: (outcome) => void outcome.catch(() => undefined),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    ...(options.pollCeilingMs === undefined ? {} : { pollCeilingMs: options.pollCeilingMs }),
  });
};

describe('G2: progress of a task is a change of its status or statusMessage (R-G2b)', () => {
  it('test 3: an unchanged working view on tasks/get is not progress', async () => {
    let progress = 0;
    const working = { taskId: TASK_ID, status: 'working', statusMessage: 'step 1' };
    const views = [working, working, working, working, { taskId: TASK_ID, status: 'completed', result: accepted }];
    await settleWith(views, { onProgress: () => (progress += 1) });
    expect(progress).toBe(2);
  });

  it('test 4: a statusMessage that changes on every poll is progress each time', async () => {
    let progress = 0;
    const views = [1, 2, 3, 4].map((step) => ({ taskId: TASK_ID, status: 'working', statusMessage: `step ${step}` }));
    await settleWith([...views, { taskId: TASK_ID, status: 'completed', result: accepted }], { onProgress: () => (progress += 1) });
    expect(progress).toBe(5);
  });

  it('counts a change of status as progress', async () => {
    let progress = 0;
    const views = [
      { taskId: TASK_ID, status: 'working' },
      { taskId: TASK_ID, status: 'working' },
      { taskId: TASK_ID, status: 'completed', result: accepted },
    ];
    await settleWith(views, { onProgress: () => (progress += 1) });
    expect(progress).toBe(2);
  });
});

describe('G2: the server poll hint is clamped to half the idle window (R-G2c)', () => {
  it('test 5: sleeps half the idle window, not an hour, when the server hints pollIntervalMs 3,600,000', async () => {
    const delays: number[] = [];
    const working = { taskId: TASK_ID, status: 'working', pollIntervalMs: 3_600_000 };
    await settleWith([working, { taskId: TASK_ID, status: 'completed', result: accepted }], { pollCeilingMs: 150_000, delays });
    expect(delays).toEqual([150_000]);
  });

  it('keeps a hint below the ceiling and the 250 ms floor', () => {
    expect(pollDelayMs(2_000, 150_000)).toBe(2_000);
    expect(pollDelayMs(undefined, 150_000)).toBe(1_000);
    expect(pollDelayMs(10, 150_000)).toBe(MIN_TASK_POLL_MS);
    expect(pollDelayMs(3_600_000, 150_000)).toBe(150_000);
    expect(pollDelayMs(3_600_000, 100)).toBe(MIN_TASK_POLL_MS);
  });

  it('derives the ceiling from the idle window, or from the overall limit when the idle window is off', () => {
    expect(pollCeilingMs(300_000, MCP_TOOL_TOTAL_TIMEOUT_MS)).toBe(150_000);
    expect(pollCeilingMs(1_800_000, MCP_TOOL_TOTAL_TIMEOUT_MS)).toBe(900_000);
    expect(pollCeilingMs(undefined, MCP_TOOL_TOTAL_TIMEOUT_MS)).toBe(MCP_TOOL_TOTAL_TIMEOUT_MS / 2);
    expect(pollCeilingMs(301, MCP_TOOL_TOTAL_TIMEOUT_MS)).toBe(150);
  });
});

describe('G2 test 6: the overall limit ends a call that keeps reporting progress, under a run deadline raised past it (end to end, fake clock)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ends at 28 hours with the overall text, not at the 7-day run deadline', async () => {
    vi.useFakeTimers();
    const clock = { now: () => Date.now(), set: () => undefined } as unknown as FakeClock;
    const progressEveryMs = 4 * 60 * 1000;
    let callStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      callStarted = resolve;
    });
    const connection = fakeConnection({
      transportKind: 'network',
      call: async (input) => {
        callStarted();
        while (input.signal?.aborted !== true) {
          await new Promise((resolve) => setTimeout(resolve, progressEveryMs));
          input.onProgress?.();
        }
        return DONE;
      },
    });
    const harness = makeExecutor(clock);
    const registry = createToolRegistry();
    registry.addSource(createMcpToolSource({ server: 'jobs', connection }));
    const startedAt = Date.now();
    const pending = harness.resultOf(await registry.snapshot(), 'mcp__jobs__long_job', {}, { deadlineAt: startedAt + 7 * 24 * 60 * 60 * 1000 });
    let outcome: { settled: false } | { settled: true; value: unknown } = { settled: false };
    void pending.then((value) => {
      outcome = { settled: true, value };
    });
    await started;
    await vi.advanceTimersByTimeAsync(MCP_TOOL_TOTAL_TIMEOUT_MS - progressEveryMs);
    expect(outcome.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2 * progressEveryMs);
    expect(outcome).toEqual({
      settled: true,
      value: {
        status: 'failed',
        output: 'The call to long_job on MCP server "jobs" reached the overall limit of 28 hours and was stopped. The server may have run it; check before repeating it.',
      },
    });
  });
});
