import type { HookPreToolDecision } from '@momonga/protocol';
import { runHooks, selectHookCommands } from './run.ts';
import type { HookReply, HookRunContext } from './run.ts';

export type PreToolHookVerdict = { decision: HookPreToolDecision; reason: string | undefined };

export type ToolHookCall = { callId: string; toolName: string; input: unknown };

export type ToolHooks = {
  matchesPreToolUse(toolName: string): boolean;
  preToolUse(call: ToolHookCall): Promise<PreToolHookVerdict | undefined>;
  postToolUse(call: ToolHookCall & { output: string }): Promise<string | undefined>;
};

export type PromptHookResult = { blocked: string | undefined; context: string[] };

export type StopHookResult = { continueWith: string | undefined };

const DECISION_RANK: Record<HookPreToolDecision, number> = { allow: 0, ask: 1, deny: 2 };

const verdictOf = (reply: HookReply): PreToolHookVerdict | undefined => {
  if (reply.execution.outcome === 'blocked') return { decision: 'deny', reason: reply.execution.message };
  const decision = reply.output?.decision;
  if (decision === undefined || decision === 'block') return undefined;
  return { decision, reason: reply.output?.reason };
};

export const resolvePreToolUse = (replies: readonly HookReply[]): PreToolHookVerdict | undefined => {
  let winner: PreToolHookVerdict | undefined;
  for (const reply of replies) {
    const verdict = verdictOf(reply);
    if (verdict !== undefined && (winner === undefined || DECISION_RANK[verdict.decision] > DECISION_RANK[winner.decision])) winner = verdict;
  }
  return winner;
};

const feedbackOf = (reply: HookReply): string[] => {
  const parts: string[] = [];
  if (reply.execution.outcome === 'error' && reply.execution.exitCode === 2 && reply.stderr.trim() !== '') parts.push(reply.stderr.trim());
  if (reply.output?.decision === 'block' && reply.output.reason !== undefined) parts.push(reply.output.reason);
  if (reply.output?.additionalContext !== undefined) parts.push(reply.output.additionalContext);
  return parts;
};

const joined = (parts: readonly string[]): string | undefined => (parts.length === 0 ? undefined : parts.join('\n'));

export const createToolHooks = (ctx: HookRunContext): ToolHooks => ({
  matchesPreToolUse: (toolName) => selectHookCommands(ctx.hooks, 'PreToolUse', toolName).length > 0,
  preToolUse: async ({ callId, toolName, input }) =>
    resolvePreToolUse(await runHooks(ctx, 'PreToolUse', toolName, { tool_name: toolName, tool_input: input, tool_use_id: callId }, callId)),
  postToolUse: async ({ callId, toolName, input, output }) => {
    const replies = await runHooks(
      ctx,
      'PostToolUse',
      toolName,
      { tool_name: toolName, tool_input: input, tool_response: output, tool_use_id: callId },
      callId,
    );
    return joined(replies.flatMap(feedbackOf));
  },
});

const blockReason = (reply: HookReply): string => {
  const reason = reply.execution.outcome === 'blocked' ? reply.execution.message : reply.output?.reason;
  return reason === undefined || reason === '' ? `the ${reply.execution.hookEvent} hook ${reply.execution.command} blocked this without a reason` : reason;
};

const contextOf = (reply: HookReply): string[] => {
  const parts: string[] = [];
  if (reply.output?.plainText !== undefined) parts.push(reply.output.plainText);
  if (reply.output?.additionalContext !== undefined) parts.push(reply.output.additionalContext);
  return parts;
};

export const runUserPromptSubmit = async (ctx: HookRunContext, prompt: string): Promise<PromptHookResult> => {
  const replies = await runHooks(ctx, 'UserPromptSubmit', undefined, { prompt });
  const blocking = replies.find((reply) => reply.execution.outcome === 'blocked' || reply.output?.decision === 'block');
  const blocked = blocking === undefined ? undefined : blockReason(blocking);
  return { blocked, context: replies.flatMap(contextOf) };
};

export const runSessionStart = async (ctx: HookRunContext, source: string): Promise<string[]> =>
  (await runHooks(ctx, 'SessionStart', source, { source })).flatMap(contextOf);

export const runStop = async (ctx: HookRunContext, stopHookActive: boolean): Promise<StopHookResult> => {
  const replies = await runHooks(ctx, 'Stop', undefined, { stop_hook_active: stopHookActive });
  const feedback = replies.flatMap((reply) => {
    if (reply.execution.outcome === 'blocked' || reply.output?.decision === 'block') return [blockReason(reply)];
    return reply.output?.additionalContext === undefined ? [] : [reply.output.additionalContext];
  });
  return { continueWith: joined(feedback) };
};

export const hasStopHooks = (ctx: HookRunContext): boolean => selectHookCommands(ctx.hooks, 'Stop', undefined).length > 0;
