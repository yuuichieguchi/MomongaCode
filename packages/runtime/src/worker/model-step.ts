import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { TokenMeter } from '@momonga/context';
import { LOWEST_REASONING_EFFORT, marginFloorFor } from '@momonga/protocol';
import type { Capabilities, CreateResponseBody, FunctionTool, InputItem, ModelResponse, MomongaResponseExtension, ResponseResource, RunEventPayload, RunState } from '@momonga/protocol';
import type { ClaimContext, Flow } from './claim-context.ts';
import { modelKey } from '../model-key.ts';
import { GatewayFailureError } from './errors.ts';
import { isRecord } from './json.ts';
import { buildNext, cancelIfInterrupted, recoverRejectedCompaction } from './context-step.ts';
import { isLoop } from './loop-detection.ts';
import { streamModel } from './model-stream.ts';
import type { StreamedModel } from './model-stream.ts';
import { summaryStopReason } from './wrap-up.ts';
import { runStopHooks } from './hook-step.ts';
import { recordCalls, settleCalls } from './tool-step.ts';
import { pinnedDigestOf } from './pinned-digest.ts';

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

type InputObservation = { input: readonly InputItem[]; tools: readonly FunctionTool[] };

type MeterFacts = { meter: TokenMeter; capabilities: Capabilities; counter: string };

type InputEstimate = { meter: TokenMeter; counter: string; inputDigest: string; estimatedTokens: number; marginTokens: number };

const meterFactsFor = async (ctx: ClaimContext, answeredByFallback: string | undefined): Promise<MeterFacts> =>
  answeredByFallback === undefined ? { meter: ctx.meter, capabilities: ctx.capabilities, counter: ctx.counter } : ctx.targetFacts(answeredByFallback);

const estimateFor = async (answered: MeterFacts, observation: InputObservation): Promise<InputEstimate> => {
  const counted = await answered.meter.count({ input: observation.input, tools: observation.tools });
  return {
    meter: answered.meter,
    counter: answered.counter,
    inputDigest: counted.inputDigest,
    estimatedTokens: counted.inputTokens,
    marginTokens: marginFloorFor(answered.capabilities.contextWindow) + counted.overTolerance,
  };
};

const fallbackTargetOf = (response: ResponseResource): string | undefined =>
  response.momonga?.fallbackCauses !== undefined && response.momonga.fallbackCauses.length > 0 ? response.momonga.target : undefined;

const truncationFailure = (reported: number, observation: Pick<InputEstimate, 'estimatedTokens' | 'marginTokens'>): { code: 'input_truncated'; message: string } => ({
  code: 'input_truncated',
  message: `The server reported ${reported} input tokens for a context the token meter counts as ${observation.estimatedTokens} tokens, which is more than the estimation margin of ${observation.marginTokens} tokens below it. The server likely truncated the input without saying so. Set the server's context length to the target's context window, or lower the target's contextWindow to what the server serves.`,
});

const billedExtensionOf = (extension: MomongaResponseExtension | undefined): ModelResponse['momonga'] => {
  if (extension === undefined) return undefined;
  const { cacheWriteInputTokens, cost } = extension;
  if (cacheWriteInputTokens === undefined && cost === undefined) return undefined;
  return {
    ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
    ...(cost === undefined ? {} : { cost }),
  };
};

const handleResult = async (
  ctx: ClaimContext,
  streamed: StreamedModel,
  position: { step: number; attempt: number },
  observation: InputObservation | undefined,
): Promise<Flow> => {
  const { result, timing } = streamed;
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
  const answered = observation === undefined ? undefined : await meterFactsFor(ctx, fallbackTargetOf(response));
  const answerCounter = response.momonga?.counter;
  if (answered !== undefined) {
    if (answerCounter === undefined) throw new GatewayFailureError('the model response names no counter');
    if (answerCounter !== answered.counter) {
      journal.append([
        { type: 'model.rejected', step: position.step, attempt: position.attempt, reason: 'counter_mismatch', counter: answerCounter, meterCounter: answered.counter },
        {
          type: 'usage.charged',
          purpose: 'rejected_answer',
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          totalTokens: usage.total_tokens,
          responseId: response.id,
          cachedInputTokens: usage.input_tokens_details.cached_tokens,
          ...(response.momonga?.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: response.momonga.cacheWriteInputTokens }),
          ...(response.momonga?.cost === undefined ? {} : { cost: response.momonga.cost }),
          timing,
        },
      ]);
      throw new GatewayFailureError(`the model response was counted by ${answerCounter}, but the token meter models ${answered.counter}`);
    }
  }
  const reusedCallId = reusedCallIdOf(journal.state, response.output);
  if (reusedCallId !== undefined) {
    const message = `The model response reuses the tool call id ${reusedCallId}, which the gateway must issue fresh for every call, so the run stops.`;
    journal.append([
      { type: 'model.stream.restarted', step: position.step, attempt: position.attempt },
      { type: 'notice', level: 'error', message, code: 'call_id_reused' },
    ]);
    return terminals.finish('FAILED', { error: { code: 'call_id_reused', message } });
  }
  const estimate = observation === undefined || answered === undefined ? undefined : await estimateFor(answered, observation);
  const before = journal.state.usage;
  const billed = billedExtensionOf(response.momonga);
  const reported = response.momonga?.contextInputTokens ?? usage.input_tokens;
  const truncation = estimate !== undefined && reported < estimate.estimatedTokens - estimate.marginTokens ? truncationFailure(reported, estimate) : undefined;
  const fallback = response.momonga;
  const recorded: RunEventPayload[] = [
    {
      type: 'model.responded',
      step: position.step,
      attempt: position.attempt,
      response: {
        id: response.id,
        status: incomplete ? 'incomplete' : 'completed',
        ...(incomplete && response.incomplete_details?.reason !== undefined ? { incompleteReason: response.incomplete_details.reason } : {}),
        output: response.output,
        usage: {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          total_tokens: usage.total_tokens,
          input_tokens_details: { cached_tokens: usage.input_tokens_details.cached_tokens },
          output_tokens_details: { reasoning_tokens: usage.output_tokens_details.reasoning_tokens },
        },
        ...(billed === undefined ? {} : { momonga: billed }),
        timing,
      },
    },
    {
      type: 'usage.updated',
      inputTokens: before.inputTokens + usage.input_tokens,
      outputTokens: before.outputTokens + usage.output_tokens,
      totalTokens: before.totalTokens + usage.total_tokens,
    },
  ];
  if (fallback?.fallbackCauses !== undefined && fallback.fallbackCauses.length > 0) {
    const failed = fallback.fallbackCauses.map((cause) => `${cause.target} failed (${cause.code === null ? cause.message : `${cause.code}: ${cause.message}`})`);
    recorded.push({
      type: 'notice',
      level: 'warning',
      message: `The model call was answered by the fallback target ${fallback.target} because ${failed.join(' and ')}.`,
      code: 'fallback_target',
    });
  }
  if (estimate !== undefined) {
    const target = fallback?.target;
    if (target === undefined) throw new GatewayFailureError('the model response names no answering target');
    recorded.push({
      type: 'meter.observed',
      target,
      counter: estimate.counter,
      fallback: fallbackTargetOf(response) !== undefined,
      ...estimate.meter.observe({ inputDigest: estimate.inputDigest, inputTokens: reported }),
    });
  }
  if (truncation !== undefined) return terminals.finish('FAILED', { error: truncation }, recorded);
  journal.append(recorded);
  ctx.memory.streak = 0;
  ctx.memory.interruptions = 0;
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

type StreamOutcome = { kind: 'result'; streamed: StreamedModel } | { kind: 'flow'; flow: Flow };

const streamRecovering = async (
  ctx: ClaimContext,
  body: CreateResponseBody,
  position: { step: number; attempt: number },
): Promise<StreamOutcome> => {
  try {
    return { kind: 'result', streamed: await streamModel(ctx, body, modelKey(ctx.run.id, position.step, position.attempt), position) };
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
  return outcome.kind === 'flow' ? outcome.flow : handleResult(ctx, outcome.streamed, position, observationOf(inFlight.body));
};

export const isSummaryRequest = (body: CreateResponseBody): boolean => body.tool_choice === 'none';

const observationOf = (body: CreateResponseBody): InputObservation | undefined => {
  if (isSummaryRequest(body)) return undefined;
  if (!Array.isArray(body.input)) throw new Error('the model request carries no input items to check the reported tokens against');
  return { input: body.input, tools: body.tools ?? [] };
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
    ...(ctx.capabilities.parallelToolCalls === undefined ? {} : { parallel_tool_calls: ctx.capabilities.parallelToolCalls }),
    ...(summarising ? { reasoning: { effort: LOWEST_REASONING_EFFORT } } : {}),
    max_output_tokens: built.maxOutputTokens,
    store: false,
    stream: true,
    metadata: { run_id: ctx.run.id, step: String(step) },
  };
  if (cancelIfInterrupted(ctx) === 'done') return 'done';
  const position = { step, attempt: 1 };
  journal.append([
    ...(wrapUp === undefined ? [] : [{ type: 'notice' as const, level: 'error' as const, message: wrapUp.notice, code: 'context_wrap_up' }]),
    { type: 'model.requested', step: position.step, attempt: position.attempt, digest: sha256Hex(canonicalJson(body)), pinnedDigest: pinnedDigestOf(body), body, anatomy: built.anatomy },
  ]);
  const streamed = await streamRecovering(ctx, body, position);
  return streamed.kind === 'flow'
    ? streamed.flow
    : handleResult(ctx, streamed.streamed, position, observationOf(body));
};
