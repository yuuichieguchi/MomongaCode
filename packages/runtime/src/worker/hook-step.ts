import { HOOK_STOPPED_CODE, STOP_HOOK_FEEDBACK_PREFIX, STOP_HOOK_MAX_CONTINUATIONS, USER_PROMPT_BLOCKED_CODE } from '@momonga/protocol';
import type { HookExecution, HooksSettings, RunEventPayload } from '@momonga/protocol';
import { runSessionStart, runStop, runUserPromptSubmit, selectHookCommands } from '@momonga/tools';
import type { HookRunContext } from '@momonga/tools';
import type { Session } from '@momonga/store';
import type { PermissionRule } from '@momonga/config';
import { permissionRulesFor } from '../governance/rules.ts';
import type { ToolPolicy } from '../ports.ts';
import type { ClaimContext, Flow } from './claim-context.ts';
import { heldSessionOf } from './known.ts';
import type { HeldSession } from './known.ts';
import { holdSandbox } from './held-sandbox.ts';
import type { Sandbox } from '@momonga/sandbox';

export const HOOK_CONTEXT_PREFIX = 'hook context';

const hookCompleted = (execution: HookExecution): RunEventPayload => ({ type: 'hook.completed', ...execution });

const contextMessage = (event: string, parts: readonly string[]): RunEventPayload[] =>
  parts.length === 0 ? [] : [{ type: 'user.message', text: `[${event} ${HOOK_CONTEXT_PREFIX}]\n${parts.join('\n')}` }];

const sessionOf = (ctx: ClaimContext): HeldSession => heldSessionOf(ctx.options.store, ctx.run.sessionId);

export const hookRunContextFor = (
  ctx: ClaimContext,
  session: HeldSession,
  hooks: HooksSettings,
  policy: ToolPolicy,
  sandbox: Sandbox,
  report: (execution: HookExecution) => void,
): HookRunContext => ({
  hooks,
  sandbox,
  sandboxPolicy: policy.sandboxPolicy,
  env: policy.env,
  shellHost: ctx.options.tools.shellHost,
  cwd: ctx.options.tools.sessionState(session).cwd,
  projectDir: session.cwd,
  tmpDir: policy.tmpDir,
  markerDir: ctx.options.tools.markerDir,
  ...(ctx.options.tools.owners === undefined ? {} : { owners: ctx.options.tools.owners }),
  ...(ctx.options.tools.lockCapability === undefined ? {} : { lockCapability: ctx.options.tools.lockCapability }),
  ...(ctx.options.tools.inspector === undefined ? {} : { inspector: ctx.options.tools.inspector }),
  runId: ctx.run.id,
  session: { id: session.id, permissionMode: session.permissionMode },
  clock: ctx.options.clock,
  signal: ctx.control.signal,
  deadlineAt: ctx.run.deadlineAt,
  started: (start) => ctx.journal.append([{ type: 'hook.started', ...start }]),
  report,
});

type LifecycleHooks = { context: HookRunContext; executions: HookExecution[]; session: HeldSession };

export type SessionCommands = { session: HeldSession; policy: ToolPolicy; sandbox: Sandbox };

export const withSessionCommands = async <T>(ctx: ClaimContext, work: (commands: SessionCommands) => Promise<T>): Promise<T> => {
  const held = await holdSandbox(ctx.options.tools.sandboxes, ctx.control.signal);
  try {
    const session = sessionOf(ctx);
    const rules: PermissionRule[] = await permissionRulesFor(ctx.options, session);
    const policy = await ctx.options.tools.policyFor(session, { env: ctx.env, rules, readableDirectories: ctx.skills.readDirectories, ruleEnforcement: held.ruleEnforcement, signal: ctx.control.signal });
    return await work({ session, policy, sandbox: held.sandbox });
  } finally {
    held.done();
  }
};

const withLifecycleHooks = <T>(ctx: ClaimContext, hooks: HooksSettings, work: (lifecycle: LifecycleHooks) => Promise<T>): Promise<T> =>
  withSessionCommands(ctx, ({ session, policy, sandbox }) => {
    const executions: HookExecution[] = [];
    return work({ context: hookRunContextFor(ctx, session, hooks, policy, sandbox, (execution) => executions.push(execution)), executions, session });
  });

const alreadyRan = (ctx: ClaimContext, event: HookExecution['hookEvent']): boolean => (ctx.journal.state.hookCompletions[event] ?? 0) > 0;

export const haltRun = (ctx: ClaimContext, event: string, reason: string | undefined): Promise<Flow> => {
  const message = reason === undefined || reason === '' ? `a ${event} hook stopped the run` : reason;
  ctx.journal.append([{ type: 'notice', level: 'warning', message: `Stopped by a ${event} hook: ${message}`, code: 'hook_stopped' }]);
  return ctx.terminals.finish('FAILED', { error: { code: HOOK_STOPPED_CODE, message } });
};

const isSubagentRun = (ctx: ClaimContext): boolean => ctx.run.parentRunId !== null;

export const runStartHooks = async (ctx: ClaimContext): Promise<Flow> => {
  if (isSubagentRun(ctx)) return 'continue';
  const session = sessionOf(ctx);
  const hooks = await ctx.options.settings.hooks(session);
  const wantsSessionStart = ctx.run.ordinal === 1 && selectHookCommands(hooks, 'SessionStart', 'startup').length > 0 && !alreadyRan(ctx, 'SessionStart');
  const wantsPrompt = selectHookCommands(hooks, 'UserPromptSubmit', undefined).length > 0 && !alreadyRan(ctx, 'UserPromptSubmit');
  if (!wantsSessionStart && !wantsPrompt) return 'continue';
  return withLifecycleHooks(ctx, hooks, async (lifecycle) => {
  if (wantsSessionStart) {
    const started = await runSessionStart(lifecycle.context, 'startup');
    ctx.journal.append([...lifecycle.executions.splice(0).map(hookCompleted), ...contextMessage('SessionStart', started.context)]);
    if (started.halt !== undefined) return haltRun(ctx, 'SessionStart', started.halt.reason);
  }
  if (wantsPrompt) {
    const [first] = ctx.options.store.readRunEvents(ctx.run.id, 0, 1);
    if (first === undefined || first.type !== 'user.message') throw new Error(`run ${ctx.run.id} does not start with a user message`);
    const result = await runUserPromptSubmit(lifecycle.context, first.text);
    ctx.journal.append([...lifecycle.executions.splice(0).map(hookCompleted), ...(result.blocked === undefined ? contextMessage('UserPromptSubmit', result.context) : [])]);
    if (result.blocked !== undefined) return ctx.terminals.finish('FAILED', { error: { code: USER_PROMPT_BLOCKED_CODE, message: result.blocked } });
  }
  return 'continue';
  });
};

export const runStopHooks = async (ctx: ClaimContext): Promise<'continue' | 'allow'> => {
  if (isSubagentRun(ctx)) return 'allow';
  const session = sessionOf(ctx);
  const hooks = await ctx.options.settings.hooks(session);
  if (selectHookCommands(hooks, 'Stop', undefined).length === 0 || ctx.journal.state.stopHookRanSinceResponse) return 'allow';
  const continuations = ctx.journal.state.stopHookContinuations;
  if (continuations >= STOP_HOOK_MAX_CONTINUATIONS) {
    ctx.journal.append([
      { type: 'notice', level: 'warning', message: `Stop hooks asked the agent to continue ${STOP_HOOK_MAX_CONTINUATIONS} times; the run stops now.`, code: 'stop_hook_continuations_exhausted' },
    ]);
    return 'allow';
  }
  return withLifecycleHooks(ctx, hooks, async (lifecycle) => {
  const result = await runStop(lifecycle.context, continuations > 0);
  if (result.halt !== undefined) {
    ctx.journal.append([
      ...lifecycle.executions.map(hookCompleted),
      { type: 'notice', level: 'info', message: `A Stop hook ended the run: ${result.halt.reason ?? 'no reason given'}`, code: 'stop_hook_ended_run' },
    ]);
    return 'allow';
  }
  const feedback: RunEventPayload[] = result.continueWith === undefined ? [] : [{ type: 'user.message', text: `${STOP_HOOK_FEEDBACK_PREFIX}${result.continueWith}` }];
  ctx.journal.append([...lifecycle.executions.map(hookCompleted), ...feedback]);
  return result.continueWith === undefined ? 'allow' : 'continue';
  });
};
