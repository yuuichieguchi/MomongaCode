import path from 'node:path';
import { HOOK_BLOCKING_EXIT_CODE, hookMatcherMatches, hookTimeoutMs, HOOK_MATCHER_EVENTS } from '@momonga/protocol';
import type { HookCommand, HookEvent, HookExecution, HooksSettings, PermissionMode } from '@momonga/protocol';
import { UNMEASURED_CAPABILITY, canonicalJson, createMarker, defaultProcessInspector, sha256Hex } from '@momonga/foundation';
import type { Clock, ProcessGroupPort, ProcessInspector } from '@momonga/foundation';
import type { Sandbox, SandboxExit, SandboxPolicy } from '@momonga/sandbox';
import { createCapture, pumpOutput } from '../capture.ts';
import { resolveBashPath } from '../builtins/shell.ts';
import type { ShellHost } from '../builtins/shell.ts';
import { createMarkerSettle, settleFinishedCommand } from '../marker-settle.ts';
import type { MarkerOwners } from '../marker-owners.ts';
import { cancellableTimer } from '../timers.ts';
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
  const finish = (execution: Omit<HookExecution, 'hookEvent' | 'command' | 'durationMs' | 'callId'>, output?: ParsedHookOutput, stderr = ''): HookReply => ({
    execution: { ...base, ...execution, durationMs: Math.max(0, ctx.clock.now() - started) },
    output,
    stderr,
  });
  const timeoutMs = Math.min(hookTimeoutMs(event, command), ctx.deadlineAt - started);
  if (ctx.signal.aborted) return finish({ outcome: 'cancelled' });
  if (timeoutMs <= 0) return finish({ outcome: 'timed_out', message: 'the run deadline passed before the hook could start' });

  const { shellHost } = ctx;
  const controller = new AbortController();
  const onCancel = (): void => controller.abort();
  ctx.signal.addEventListener('abort', onCancel, { once: true });
  const timer = cancellableTimer(timeoutMs);
  let timedOut = false;
  void timer.done.then(() => {
    timedOut = true;
    controller.abort();
  });
  const stdin = JSON.stringify({
    session_id: ctx.session.id,
    cwd: ctx.cwd,
    permission_mode: ctx.session.permissionMode,
    hook_event_name: event,
    ...payload,
  });
  const marker = path.join(ctx.markerDir, `hook-${sha256Hex(canonicalJson([ctx.runId, event, callId ?? null, command.command]))}`);
  const inspector = ctx.inspector ?? defaultProcessInspector();
  let handle: Awaited<ReturnType<typeof createMarker>> | undefined;
  let settle: ReturnType<typeof createMarkerSettle> | undefined;
  let spawned = false;
  let running = true;
  ctx.owners?.register(path.basename(marker), { alive: () => running });
  try {
    handle = await createMarker(marker, { capability: inspector.capability ?? UNMEASURED_CAPABILITY });
    ctx.owners?.remember(path.basename(marker), handle.mode);
    settle = createMarkerSettle({ marker, mode: handle.mode, inspector, ...(ctx.groupPort === undefined ? {} : { groupPort: ctx.groupPort }), onWarning: () => undefined });
    const child = ctx.sandbox.spawn(
      {
        argv: [resolveBashPath(shellHost.platform, { isExecutable: shellHost.isExecutable, env: ctx.env }), '-c', command.command],
        cwd: ctx.cwd,
        env: { ...ctx.env, MOMONGA_PROJECT_DIR: ctx.projectDir },
        stdin,
        markerFile: marker,
        ...(ctx.tmpDir === undefined ? {} : { tmpDir: ctx.tmpDir }),
      },
      ctx.sandboxPolicy,
      controller.signal,
      { markerFd: handle.fd },
    );
    spawned = true;
    const captures = [createCapture(), createCapture()] as const;
    const pump = pumpOutput([child.stdout, child.stderr], (index, chunk) => captures[index === 0 ? 0 : 1].push(chunk));
    let exit: SandboxExit;
    try {
      exit = await child.exited;
      await settleFinishedCommand(settle, { pgid: child.pgid, exit, signal: controller.signal });
      await pump.settle();
    } finally {
      await pump.close();
    }
    const failure = pump.failure();
    if (failure !== undefined) throw failure.error;
    const stdout = captures[0].text();
    const stderr = captures[1].text();
    if (timedOut) return finish({ outcome: 'timed_out', message: `the hook exceeded its ${timeoutMs} ms timeout` }, undefined, stderr);
    if (ctx.signal.aborted) return finish({ outcome: 'cancelled' }, undefined, stderr);
    if (exit.signal !== null) return finish({ outcome: 'error', message: `the hook was terminated by ${exit.signal}` }, undefined, stderr);
    const exitCode = exit.code ?? 0;
    if (exitCode === HOOK_BLOCKING_EXIT_CODE) {
      const message = stderr.trim();
      if (BLOCKING_EVENTS.has(event)) return finish({ outcome: 'blocked', exitCode, decision: event === 'PreToolUse' ? 'deny' : 'block', message }, undefined, stderr);
      return finish({ outcome: 'error', exitCode, message }, undefined, stderr);
    }
    const parsed = parseHookOutput(event, stdout);
    if (!parsed.ok) return finish({ outcome: 'error', exitCode, message: parsed.message }, undefined, stderr);
    const output = parsed.value;
    if (exitCode !== 0 && stdout.trim().startsWith('{') === false) {
      return finish({ outcome: 'error', exitCode, message: firstLine(stderr) }, undefined, stderr);
    }
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
  } finally {
    handle?.close();
    if (handle !== undefined && !spawned) await settle?.discard();
    else await settle?.remove();
    running = false;
    timer.cancel();
    ctx.signal.removeEventListener('abort', onCancel);
  }
};

export const runHooks = async (
  ctx: HookRunContext,
  event: HookEvent,
  matchValue: string | undefined,
  payload: Record<string, unknown>,
  callId?: string,
): Promise<HookReply[]> => {
  const commands = selectHookCommands(ctx.hooks, event, matchValue);
  const replies = await Promise.all(commands.map((command) => executeHook(ctx, event, command, payload, callId)));
  for (const reply of replies) ctx.report(reply.execution);
  return replies;
};
