import fs from 'node:fs';
import path from 'node:path';
import { defineTool } from '@momonga/tools';
import type { AnyTool, OutputFit, ToolContext } from '@momonga/tools';
import { deferred } from './deferred.ts';
import type { Deferred } from './deferred.ts';

export type Execution = {
  name: string;
  callId: string;
  input: Record<string, unknown>;
  traceparent: string | undefined;
  outputFit: OutputFit;
  step: number;
};

type Hook = (input: Record<string, unknown>, ctx: ToolContext) => void | Promise<void>;

export type FakeToolbox = {
  executions: Execution[];
  reconciles: string[];
  reconcileHook: (() => Promise<void>) | undefined;
  hooks: Partial<Record<string, Hook>>;
  waitStarted: Deferred<void>;
  waitSignals: AbortSignal[];
  counter: number;
  tools(): AnyTool[];
};

const STRING_FIELD = { type: 'string' } as const;

const schema = (fields: string[], required: string[] = fields): Record<string, unknown> => ({
  type: 'object',
  properties: Object.fromEntries(fields.map((field) => [field, STRING_FIELD])),
  required,
  additionalProperties: false,
});

export const createFakeToolbox = (): FakeToolbox => {
  const box: FakeToolbox = {
    executions: [],
    reconciles: [],
    reconcileHook: undefined,
    hooks: {},
    waitStarted: deferred<void>(),
    waitSignals: [],
    counter: 0,
    tools: () => [echo, counter, write, shell, plan, wait, mark, probe],
  };

  const record = async (name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<void> => {
    box.executions.push({ name, callId: ctx.callId, input, traceparent: ctx.traceparent, outputFit: ctx.outputFit, step: ctx.step });
    await box.hooks[name]?.(input, ctx);
  };

  const echo = defineTool<Record<string, unknown>>({
    name: 'Echo',
    description: 'Echo a value back',
    kind: 'read',
    output: 'harness',
    sideEffect: 'read_only',
    inputSchema: schema(['value']),
    timeoutMs: 60_000,
    title: (input) => `Echo ${String(input['value'])}`,
    subject: () => ({ kind: 'none', tool: 'Echo' }),
    execute: async (input, ctx) => {
      await record('Echo', input, ctx);
      return { status: 'completed', output: `echo:${String(input['value'])}` };
    },
  });

  const counter = defineTool<Record<string, unknown>>({
    name: 'Counter',
    description: 'Return an increasing count',
    kind: 'read',
    output: 'harness',
    sideEffect: 'read_only',
    inputSchema: schema(['value']),
    timeoutMs: 60_000,
    title: () => 'Counter',
    subject: () => ({ kind: 'none', tool: 'Counter' }),
    execute: async (input, ctx) => {
      await record('Counter', input, ctx);
      box.counter += 1;
      return { status: 'completed', output: `count:${box.counter}` };
    },
  });

  const write = defineTool<Record<string, unknown>>({
    name: 'Write',
    description: 'Write a file',
    kind: 'edit',
    output: 'harness',
    sideEffect: 'write',
    subjectKind: 'path',
    inputSchema: schema(['file_path', 'content']),
    timeoutMs: 60_000,
    title: (input) => `Write ${String(input['file_path'])}`,
    locations: (input, ctx) => [{ path: path.resolve(ctx.workingDirectory, String(input['file_path'])) }],
    subject: (input) => ({ kind: 'path', tool: 'Write', paths: [String(input['file_path'])], access: 'write' }),
    execute: async (input, ctx) => {
      await record('Write', input, ctx);
      const target = path.resolve(ctx.session.workingDirectory, String(input['file_path']));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, String(input['content']));
      return { status: 'completed', output: `wrote ${String(input['file_path'])}` };
    },
  });

  const shell = defineTool<Record<string, unknown>>({
    name: 'Bash',
    description: 'Run a command without spawning anything',
    kind: 'execute',
    output: 'harness',
    sideEffect: 'exec',
    subjectKind: 'command',
    inputSchema: schema(['command']),
    timeoutMs: 60_000,
    title: (input) => String(input['command']),
    subject: (input) => ({ kind: 'command', tool: 'Bash', command: String(input['command']) }),
    execute: async (input, ctx) => {
      await record('Bash', input, ctx);
      return { status: 'completed', output: `ran ${String(input['command'])}` };
    },
  });

  const plan = defineTool<Record<string, unknown>>({
    name: 'UpdatePlan',
    description: 'Update the plan',
    kind: 'think',
    output: 'harness',
    sideEffect: 'read_only',
    inputSchema: schema(['step']),
    timeoutMs: 60_000,
    title: () => 'Update plan',
    subject: () => ({ kind: 'none', tool: 'UpdatePlan' }),
    execute: async (input, ctx) => {
      await record('UpdatePlan', input, ctx);
      return {
        status: 'completed',
        output: 'plan updated',
        plan: [
          { content: String(input['step']), priority: 'high', status: 'in_progress' },
          { content: 'verify', priority: 'medium', status: 'pending' },
        ],
      };
    },
  });

  const wait = defineTool<Record<string, unknown>>({
    name: 'Wait',
    description: 'Wait until cancelled',
    kind: 'other',
    output: 'harness',
    sideEffect: 'read_only',
    inputSchema: schema(['value']),
    timeoutMs: 600_000,
    title: () => 'Wait',
    subject: () => ({ kind: 'none', tool: 'Wait' }),
    execute: async (input, ctx) => {
      await record('Wait', input, ctx);
      box.waitSignals.push(ctx.signal);
      box.waitStarted.resolve();
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) resolve();
        else ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { status: 'failed', output: 'wait interrupted' };
    },
  });

  const mark = defineTool<Record<string, unknown>>({
    name: 'Mark',
    description: 'Record a mark with a side effect',
    kind: 'edit',
    output: 'harness',
    sideEffect: 'write',
    subjectKind: 'none',
    inputSchema: schema(['value']),
    timeoutMs: 60_000,
    title: (input) => `Mark ${String(input['value'])}`,
    subject: () => ({ kind: 'none', tool: 'Mark' }),
    execute: async (input, ctx) => {
      await record('Mark', input, ctx);
      return { status: 'completed', output: `marked ${String(input['value'])}` };
    },
    reconcile: async (input, record) => {
      box.reconciles.push(record.key);
      await box.reconcileHook?.();
      return { outcome: 'already_applied', output: `already marked ${String(input['value'])}` };
    },
  });

  const probe = defineTool<Record<string, unknown>>({
    name: 'Probe',
    description: 'Report the tool context',
    kind: 'read',
    output: 'harness',
    sideEffect: 'read_only',
    inputSchema: schema(['value']),
    timeoutMs: 60_000,
    title: () => 'Probe',
    subject: () => ({ kind: 'none', tool: 'Probe' }),
    execute: async (input, ctx) => {
      await record('Probe', input, ctx);
      return { status: 'completed', output: `probe ${String(input['value'])}` };
    },
  });

  return box;
};
