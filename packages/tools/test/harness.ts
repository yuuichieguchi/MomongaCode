import fs from 'node:fs';
import path from 'node:path';
import { createToolExecutor, createToolRegistry, defineTool } from '@momonga/tools';
import type { AnyTool, BatchInput, ToolCall, ToolContext, ToolDefinition, ToolSet } from '@momonga/tools';
import type { PermissionRule } from '@momonga/policy';
import type { PermissionMode } from '@momonga/protocol';
import { fakeSandbox, makeBlobs, makeClock, makeIdempotency, makeLayout, sandboxPolicyFor } from './helpers.ts';
import type { Layout } from './helpers.ts';

export type Input = Record<string, unknown>;

export const OPEN_SCHEMA = { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false } as const;

export const makeTool = (name: string, overrides: Partial<ToolDefinition<Input>> = {}): AnyTool =>
  defineTool<Input>({
    name,
    description: `${name} test tool`,
    kind: 'read',
    sideEffect: 'read_only',
    inputSchema: OPEN_SCHEMA,
    title: () => `${name} title`,
    timeoutMs: 60_000,
    subject: () => ({ kind: 'none', tool: name }),
    execute: async () => ({ status: 'completed', output: `${name} ok` }),
    ...overrides,
  });

export const toolSetOf = async (...tools: AnyTool[]): Promise<ToolSet> => {
  const registry = createToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry.snapshot();
};

export type Harness = ReturnType<typeof makeHarness>;

export const makeHarness = (options: { maxInlineOutputChars?: number; maxParallel?: number; idempotencyTtlMs?: number; attempts?: number } = {}) => {
  const layout: Layout = makeLayout();
  const clock = makeClock();
  const idempotency = makeIdempotency(clock);
  const blobs = makeBlobs();
  const markerDir = path.join(layout.root, 'markers');
  fs.mkdirSync(markerDir, { mode: 0o700 });
  const executor = createToolExecutor({
    idempotency: idempotency.port,
    blobs: blobs.port,
    clock,
    processMarkerDir: markerDir,
    ...(options.idempotencyTtlMs === undefined ? {} : { idempotencyTtlMs: options.idempotencyTtlMs }),
    ...(options.maxInlineOutputChars === undefined ? {} : { maxInlineOutputChars: options.maxInlineOutputChars }),
    ...(options.maxParallel === undefined ? {} : { maxParallel: options.maxParallel }),
    readOnlyRetry: { attempts: options.attempts ?? 3, baseMs: 0, maxMs: 0 },
  });
  const session = { cwd: layout.project, readLedger: new Map<string, { sha256: string; mtimeMs: number }>() };
  const started: string[] = [];
  const input = (
    toolSet: ToolSet,
    calls: ToolCall[],
    extra: Partial<BatchInput> & { mode?: PermissionMode; rules?: PermissionRule[] } = {},
  ): BatchInput => ({
    calls,
    toolSet,
    runId: 'run-1',
    step: 1,
    mode: 'default',
    rules: [],
    home: layout.home,
    roots: [layout.project],
    env: { LANG: 'C' },
    session,
    sandbox: fakeSandbox,
    sandboxPolicy: sandboxPolicyFor(layout),
    deadlineAt: clock.now() + 600_000,
    signal: new AbortController().signal,
    protectedPaths: [],
    onStarted: (callId: string) => {
      started.push(callId);
    },
    ...extra,
  });
  return { layout, markerDir, clock, idempotency, blobs, executor, session, started, input };
};

export type ExecuteFn = (input: Input, ctx: ToolContext, prepared: Record<string, unknown> | undefined) => ReturnType<ToolDefinition<Input>['execute']>;

export const call = (callId: string, name: string, args: unknown = {}, approval?: 'allow_once' | 'allow_always'): ToolCall =>
  approval === undefined ? { callId, name, arguments: args } : { callId, name, arguments: args, approval };
