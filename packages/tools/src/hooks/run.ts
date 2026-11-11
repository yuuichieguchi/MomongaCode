import path from 'node:path';
import { HOOK_BLOCKING_EXIT_CODE, hookMatcherMatches, hookTimeoutMs, HOOK_MATCHER_EVENTS } from '@momonga/protocol';
import type { HookCommand, HookEvent, HookExecution, HookStart, HooksSettings, PermissionMode } from '@momonga/protocol';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { Clock, ProcessGroupPort, ProcessInspector } from '@momonga/foundation';
import type { Sandbox, SandboxPolicy } from '@momonga/sandbox';
import type { ShellHost } from '../builtins/shell.ts';
import type { MarkerOwners } from '../marker-owners.ts';
import { runSandboxedCommand } from '../sandboxed-command.ts';
import { parseHookOutput } from './output.ts';
import type { ParsedHookOutput } from './output.ts';

const BLOCKING_EVENTS: ReadonlySet<HookEvent> = new Set(['PreToolUse', 'UserPromptSubmit', 'Stop']);

export type HookRunContext = {
  hooks: HooksSettings;
  sandbox: Sandbox;
  sandboxPolicy: SandboxPolicy;
  env: Readonly<Record<string, string>>;
  shellHost: ShellHost;
  cwd: string;
  projectDir: string;
  tmpDir?: string;
  markerDir: string;
  inspector?: ProcessInspector;
  groupPort?: ProcessGroupPort;
  owners?: MarkerOwners;
  runId: string;
  session: { id: string; permissionMode: PermissionMode };
  clock: Clock;
  signal: AbortSignal;
  deadlineAt: number;
  started(start: HookStart): void;
  report(execution: HookExecution): void;
};

export type HookReply = { execution: HookExecution; output: ParsedHookOutput | undefined; stderr: string };

export const selectHookCommands = (hooks: HooksSettings, event: HookEvent, matchValue: string | undefined): HookCommand[] => {
  const matcherApplies = HOOK_MATCHER_EVENTS.includes(event);
  const selected: HookCommand[] = [];
  for (const group of hooks[event] ?? []) {
    if (matcherApplies && matchValue !== undefined && !hookMatcherMatches(group.matcher, matchValue)) continue;
    for (const command of group.hooks) {
      if (!selected.some((existing) => existing.command === command.command)) selected.push(command);
    }
  }
  return selected;
};

const firstLine = (text: string): string => text.trim().split('\n')[0] ?? '';

const executeHook = async (
  ctx: HookRunContext,
  event: HookEvent,
  command: HookCommand,
  payload: Record<string, unknown>,
  callId: string | undefined,
): Promise<HookReply> => {
  const started = ctx.clock.now();
  const base = { hookEvent: event, command: command.command, ...(callId === undefined ? {} : { callId }) } as const;
  let groupNotice: string | undefined;
  const systemMessageOf = (hookMessage: string | undefined): { systemMessage?: string } => {
    const lines = [hookMessage, groupNotice].filter((line): line is string => line !== undefined);
    return lines.length === 0 ? {} : { systemMessage: lines.join('\n') };
  };
  const finish = (execution: Omit<HookExecution, 'hookEvent' | 'command' | 'durationMs' | 'callId'>, output?: ParsedHookOutput, stderr = ''): HookReply => ({
    execution: { ...base, ...execution, ...systemMessageOf(execution.systemMessage), durationMs: Math.max(0, ctx.clock.now() - started) },
    output,
    stderr,
  });
  const timeoutMs = Math.min(hookTimeoutMs(event, command), ctx.deadlineAt - started);
  if (ctx.signal.aborted) return finish({ outcome: 'cancelled' });
  if (timeoutMs <= 0) return finish({ outcome: 'timed_out', message: 'the run deadline passed before the hook could start' });

  const stdin = JSON.stringify({
    session_id: ctx.session.id,
    cwd: ctx.cwd,
    permission_mode: ctx.session.permissionMode,
    hook_event_name: event,
    ...payload,
  });
  const result = await runSandboxedCommand({
    command: command.command,
    sandbox: ctx.sandbox,
    sandboxPolicy: ctx.sandboxPolicy,
    env: { ...ctx.env, MOMONGA_PROJECT_DIR: ctx.projectDir },
    shellHost: ctx.shellHost,
    cwd: ctx.cwd,
    markerFile: path.join(ctx.markerDir, `hook-${sha256Hex(canonicalJson([ctx.runId, event, callId ?? null, command.command]))}`),
    clock: ctx.clock,
    signal: ctx.signal,
    timeoutMs,
    stdin,
    ...(ctx.tmpDir === undefined ? {} : { tmpDir: ctx.tmpDir }),
    ...(ctx.inspector === undefined ? {} : { inspector: ctx.inspector }),
    ...(ctx.groupPort === undefined ? {} : { groupPort: ctx.groupPort }),
    ...(ctx.owners === undefined ? {} : { owners: ctx.owners }),
  });
  if (result.kind === 'spawn_error') return finish({ outcome: 'error', message: `the hook could not start: ${result.message}` });
  groupNotice = result.groupNotice;
  if (result.kind === 'timed_out') return finish({ outcome: 'timed_out', message: `the hook exceeded its ${timeoutMs} ms timeout` }, undefined, result.stderr);
  if (result.kind === 'cancelled') return finish({ outcome: 'cancelled' }, undefined, result.stderr);
  if (result.kind === 'signaled') return finish({ outcome: 'error', message: `the hook was terminated by ${result.signal}` }, undefined, result.stderr);
  const { exitCode, stdout, stderr } = result;
  if (exitCode === HOOK_BLOCKING_EXIT_CODE) {
    const message = stderr.trim();
    if (BLOCKING_EVENTS.has(event)) return finish({ outcome: 'blocked', exitCode, decision: event === 'PreToolUse' ? 'deny' : 'block', message }, undefined, stderr);
    return finish({ outcome: 'error', exitCode, message }, undefined, stderr);
  }
  if (exitCode !== 0) {
    const reported = firstLine(stderr);
    return finish({ outcome: 'error', exitCode, message: reported === '' ? `the hook exited with code ${exitCode}` : reported }, undefined, stderr);
  }
  const parsed = parseHookOutput(event, stdout);
  if (!parsed.ok) return finish({ outcome: 'error', exitCode, message: parsed.message }, undefined, stderr);
  const output = parsed.value;
  return finish(
    {
      outcome: 'success',
      exitCode,
      ...(output.decision === undefined ? {} : { decision: output.decision }),
      ...(output.reason === undefined ? {} : { message: output.reason }),
      ...(output.systemMessage === undefined ? {} : { systemMessage: output.systemMessage }),
      ...(output.updatedInput === undefined ? {} : { updatedInput: output.updatedInput }),
      ...(output.halt === undefined ? {} : { halted: true as const }),
      ...(output.halt?.reason === undefined ? {} : { stopReason: output.halt.reason }),
    },
    output,
    stderr,
  );
};

export const runHooks = async (
  ctx: HookRunContext,
  event: HookEvent,
  matchValue: string | undefined,
  payload: Record<string, unknown>,
  callId?: string,
): Promise<HookReply[]> => {
  const commands = selectHookCommands(ctx.hooks, event, matchValue);
  const replies = await Promise.all(
    commands.map((command) => {
      ctx.started({ event, command: command.command, ...(callId === undefined ? {} : { callId }) });
      return executeHook(ctx, event, command, payload, callId);
    }),
  );
  for (const reply of replies) ctx.report(reply.execution);
  return replies;
};
