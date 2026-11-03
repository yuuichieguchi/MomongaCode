import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { CreateResponseBody, ResponseResource, RunState } from '@momonga/protocol';
import type { ClaimContext, Flow } from './claim-context.ts';
import { modelKey } from '../model-key.ts';
import { GatewayFailureError } from './errors.ts';
import { isRecord } from './json.ts';
import { buildNext, cancelIfInterrupted, recoverRejectedCompaction } from './context-step.ts';
import { isLoop } from './loop-detection.ts';
import { streamModel } from './model-stream.ts';
import type { ModelResult } from './model-stream.ts';
import { summaryStopReason } from './wrap-up.ts';
import { runStopHooks } from './hook-step.ts';
import { recordCalls, settleCalls } from './tool-step.ts';

const MODEL_ATTEMPT = 1;
const DEADLINE_CODE = 'deadline_exceeded';
const REFUSAL_CODES = ['guardrail_violation', 'refusal', 'content_filter'];

type LimitReason = 'max_steps' | 'budget';

const isRequestBody = (value: unknown): value is CreateResponseBody => isRecord(value) && typeof value['model'] === 'string';

const limitReached = (ctx: ClaimContext): LimitReason | undefined => {
  const state = ctx.journal.state;
  if (state.step >= ctx.limits.maxSteps) return 'max_steps';
  if (ctx.options.store.treeTokens(ctx.run.id) >= ctx.limits.maxTotalTokens) return 'budget';
  return undefined;
};

const incompleteFailure = (reason: string | undefined, terminals: ClaimContext['terminals']): Flow => {
  if (reason === 'max_output_tokens') return terminals.finish('STOPPED', { stopReason: 'max_tokens' });
  if (reason === 'content_filter') return terminals.finish('STOPPED', { stopReason: 'refusal' });
  return terminals.finish('FAILED', {
    error: { code: 'incomplete_response', message: `the model response was incomplete for an unsupported reason: ${reason ?? 'unknown'}` },
  });
};

export const responsePending = (state: RunState): boolean => {
  const response = state.lastResponse;
  return (
    response !== undefined &&
    response.step === state.step &&
    state.inFlightModelRequest === undefined &&
    response.callIds.every((callId) => state.pendingCalls[callId] === undefined)
  );
};

export const decideAfterResponse = async (ctx: ClaimContext): Promise<Flow> => {
  const { journal, terminals } = ctx;
  const response = journal.state.lastResponse;
  if (response === undefined) throw new Error(`run ${ctx.run.id} has no recorded model response to decide on`);
  if (journal.state.steps[response.step]?.summary === true) {
    return terminals.finish('STOPPED', { stopReason: summaryStopReason(response.step, ctx.limits.maxSteps) });
  }
  if (response.refusal) return terminals.finish('STOPPED', { stopReason: 'refusal' });
  if (response.callIds.length === 0) {
    if (response.incomplete) return incompleteFailure(response.incompleteReason, terminals);
    if ((await runStopHooks(ctx)) === 'continue') return 'continue';
    return terminals.finish('COMPLETED');
  }
  if (isLoop(journal.state, ctx.limits.loopThreshold)) {
    journal.append([
      { type: 'notice', level: 'warning', message: `The model repeated the same tool call with the same results ${ctx.limits.loopThreshold} times in a row, so the run stops.`, code: 'tool_loop_detected' },
    ]);
    return terminals.finish('STOPPED', { stopReason: 'loop' });
  }
  recordCalls(ctx);
  return settleCalls(ctx);
};

const handleResult = async (
  ctx: ClaimContext,
  result: ModelResult,
  position: { step: number; attempt: number },
  observation: { inputDigest: string } | undefined,
): Promise<Flow> => {
  const { journal, terminals } = ctx;
  if (result.kind === 'failed') {
    if (result.code !== null && REFUSAL_CODES.includes(result.code)) {
      journal.append([{ type: 'notice', level: 'warning', message: `The model refused the request: ${result.message}`, code: 'model_refused' }]);
      return terminals.finish('STOPPED', { stopReason: 'refusal' });
    }
    if (result.code === DEADLINE_CODE) return terminals.finish('STOPPED', { stopReason: 'timeout' });
    throw new GatewayFailureError(`${result.code ?? 'error'}: ${result.message}`);
  }
  const { response, incomplete } = result;
  const usage = response.usage;
  if (usage === null) throw new GatewayFailureError('the model response carries no usage');
  const reusedCallId = reusedCallIdOf(journal.state, response.output);
  if (reusedCallId !== undefined) {
    const message = `The model response reuses the tool call id ${reusedCallId}, which the gateway must issue fresh for every call, so the run stops.`;
    journal.append([
      { type: 'model.stream.restarted', step: position.step, attempt: position.attempt },
      { type: 'notice', level: 'error', message, code: 'call_id_reused' },
    ]);
    return terminals.finish('FAILED', { error: { code: 'call_id_reused', message } });
  }
  const before = journal.state.usage;
  journal.append([
    {
      type: 'model.responded',
      step: position.step,
      attempt: position.attempt,
      response: {
        status: incomplete ? 'incomplete' : 'completed',
        ...(incomplete && response.incomplete_details?.reason !== undefined ? { incompleteReason: response.incomplete_details.reason } : {}),
        output: response.output,
        usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, total_tokens: usage.total_tokens },
      },
    },
    {
      type: 'usage.updated',
      inputTokens: before.inputTokens + usage.input_tokens,
      outputTokens: before.outputTokens + usage.output_tokens,
      totalTokens: before.totalTokens + usage.total_tokens,
    },
  ]);
  ctx.memory.streak = 0;
  ctx.memory.interruptions = 0;
  if (observation !== undefined) ctx.meter.observe({ inputDigest: observation.inputDigest, inputTokens: response.momonga?.contextInputTokens ?? usage.input_tokens });
  return decideAfterResponse(ctx);
};

const streamedBeforeRestart = (state: RunState, position: { step: number; attempt: number }): boolean =>
  state.streaming?.seen === true && state.streaming.step === position.step && state.streaming.attempt === position.attempt;

const reusedCallIdOf = (state: RunState, output: ResponseResource['output']): string | undefined => {
  const known = new Set<string>([
    ...state.history.flatMap((entry) => (entry.item.type === 'function_call' ? [entry.item.call_id] : [])),
    ...Object.keys(state.pendingCalls),
    ...state.evicted,
  ]);
  for (const item of output) {
    if (item.type !== 'function_call') continue;
    if (known.has(item.call_id)) return item.call_id;
    known.add(item.call_id);
  }
  return undefined;
};

type StreamOutcome = { kind: 'result'; result: ModelResult } | { kind: 'flow'; flow: Flow };

const streamRecovering = async (
  ctx: ClaimContext,
  body: CreateResponseBody,
  position: { step: number; attempt: number },
): Promise<StreamOutcome> => {
  try {
    return { kind: 'result', result: await streamModel(ctx, body, modelKey(ctx.run.id, position.step, position.attempt), position) };
  } catch (error) {
    const recovery = recoverRejectedCompaction(ctx, error, position);
    delete ctx.control.inFlight.modelKey;
    return { kind: 'flow', flow: recovery === 'done' ? 'done' : 'continue' };
  }
};

export const resumeInFlight = async (ctx: ClaimContext): Promise<Flow> => {
  const inFlight = ctx.journal.state.inFlightModelRequest;
  if (inFlight === undefined) return 'continue';
  if (!isRequestBody(inFlight.body)) throw new Error(`the recorded model request of step ${inFlight.step} is not a response body`);
  const position = { step: inFlight.step, attempt: inFlight.attempt };
  if (ctx.control.yieldRequested()) return ctx.terminals.yieldLease();
  if (streamedBeforeRestart(ctx.journal.state, position)) ctx.journal.append([{ type: 'model.stream.restarted', step: position.step, attempt: position.attempt }]);
  const outcome = await streamRecovering(ctx, inFlight.body, position);
  return outcome.kind === 'flow' ? outcome.flow : handleResult(ctx, outcome.result, position, undefined);
};

export const runModelStep = async (ctx: ClaimContext): Promise<Flow> => {
  const { journal, terminals, options } = ctx;
  if (options.clock.now() >= ctx.run.deadlineAt) return terminals.finish('STOPPED', { stopReason: 'timeout' });
  if (ctx.control.yieldRequested()) return terminals.yieldLease();
  const limit = limitReached(ctx);
  const outcome = await buildNext(ctx, limit === undefined ? {} : { wrapUp: limit });
  if (outcome.kind === 'done') return 'done';
  const { built, wrapUp } = outcome;
  const summarising = limit !== undefined || wrapUp !== undefined;
  const step = journal.state.step + 1;
  const body: CreateResponseBody = {
    model: ctx.alias,
    input: built.input,
    tools: built.tools,
    tool_choice: summarising ? 'none' : 'auto',
    parallel_tool_calls: ctx.capabilities.parallelToolCalls,
    max_output_tokens: built.maxOutputTokens,
    store: false,
    stream: true,
    metadata: { run_id: ctx.run.id, step: String(step) },
  };
  if (cancelIfInterrupted(ctx) === 'done') return 'done';
  const position = { step, attempt: MODEL_ATTEMPT };
  journal.append([
    ...(wrapUp === undefined ? [] : [{ type: 'notice' as const, level: 'error' as const, message: wrapUp.notice, code: 'context_wrap_up' }]),
    { type: 'model.requested', step: position.step, attempt: position.attempt, digest: sha256Hex(canonicalJson(body)), body },
  ]);
  const streamed = await streamRecovering(ctx, body, position);
  return streamed.kind === 'flow' ? streamed.flow : handleResult(ctx, streamed.result, position, summarising ? undefined : { inputDigest: built.inputDigest });
};
