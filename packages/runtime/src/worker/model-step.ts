import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { BuiltContext, TokenMeter } from '@momonga/context';
import { BUDGET_EXCEEDED_CODE, LOWEST_REASONING_EFFORT, describeFallbackCause, marginFloorFor, wireUsageOf } from '@momonga/protocol';
import { billedDetailOf, priceOutcomeOf } from './model-stream.ts';
import type { BudgetExhausted, ModelQuote, Capabilities, CreateResponseBody, ModelRejectionReason, FunctionTool, InputItem, ModelResponse, MomongaResponseExtension, ResponseResource, RunEventPayload, RunState } from '@momonga/protocol';
import type { ClaimContext, Flow } from './claim-context.ts';
import { modelKey } from '../model-key.ts';
import { GatewayFailureError } from './errors.ts';
import { GatewayRequestError } from '../gateway-client.ts';
import { responseFailureDisposition, terminalOf } from './gateway-policy.ts';
import { outputBoundOf } from './output-bound.ts';
import { isRecord } from './json.ts';
import { buildNext, cancelIfInterrupted, recoverRejectedCompaction } from './context-step.ts';
import { loopSignatureOf } from './loop-detection.ts';
import { loopGuidanceFactsOf, loopGuidanceItem } from './loop-guidance.ts';
import type { CallResult } from './loop-guidance.ts';
import { streamModel } from './model-stream.ts';
import type { StreamedModel } from './model-stream.ts';
import { summaryStopReason } from './wrap-up.ts';
import { requestBudgetOf, stepsExhausted } from './budget.ts';
import { admissionFor, ceilingOf, overCeiling, quoteFor } from './admitted-request.ts';
import type { AdmissionProof } from './admitted-request.ts';
import { stopExhausted, stopReasonOf } from './budget-stop.ts';
import type { StepAdmission } from './budget.ts';
import { stopGate } from './verification-step.ts';
import { recordCalls, settleCalls, settleHeld } from './tool-step.ts';
import { hasHeld, quiesce } from './held-calls.ts';
import { pinnedDigestOf } from './pinned-digest.ts';
import { recordPrefix } from './prefix-record.ts';
import { cacheControlsOf } from './cache-controls.ts';
import { EXACT_MODEL } from './exact-model.ts';
import { offeredRecordFor } from './tool-offer.ts';

const DEADLINE_CODE = 'deadline_exceeded';
const REFUSAL_CODES = ['guardrail_violation', 'refusal', 'content_filter'];

const isRequestBody = (value: unknown): value is CreateResponseBody => isRecord(value) && typeof value['model'] === 'string';

const admissionOf = (ctx: ClaimContext, built: BuiltContext, quote: ModelQuote | undefined): StepAdmission =>
  admissionFor(ctx.budget, { inputTokens: built.inputTokens, marginTokens: built.budget.margin, maxOutputTokens: built.maxOutputTokens }, quote);

const incompleteFailure = (reason: string | undefined, terminals: ClaimContext['terminals']): Promise<Flow> => {
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
    const settled = await settleHeld(ctx);
    if (settled === 'done') return 'done';
    if (settled !== 'continue' && settled > 0) return 'continue';
    if (hasHeld(journal.state)) return quiesce(ctx);
    const gated = await stopGate(ctx);
    return gated === 'allow' ? terminals.finish('COMPLETED') : gated;
  }
  const repeatedSignature = loopSignatureOf(journal.state, ctx.limits.loopThreshold);
  const warning: RunEventPayload[] = [];
  if (repeatedSignature !== undefined) {
    const warned = ctx.token.loopGuidance && journal.state.loopWarned?.signature !== repeatedSignature;
    if (warned) {
      warning.push(
        { type: 'loop.warned', signature: repeatedSignature },
        {
          type: 'notice',
          level: 'warning',
          message: `The model repeated the same tool call with the same results ${ctx.limits.loopThreshold} times in a row, so it is warned and the next identical call stops the run.`,
          code: 'tool_loop_warned',
        },
      );
    } else {
      const repeats = ctx.token.loopGuidance ? ctx.limits.loopThreshold + 1 : ctx.limits.loopThreshold;
      journal.append([
        { type: 'notice', level: 'warning', message: `The model repeated the same tool call with the same results ${repeats} times in a row, so the run stops.`, code: 'tool_loop_detected' },
      ]);
      return terminals.finish('STOPPED', { stopReason: 'loop' });
    }
  }
  await recordCalls(ctx, warning);
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

type FallbackDecision = { fallback: false } | { fallback: true; target: string | undefined };

const fallbackOf = (response: ResponseResource): FallbackDecision =>
  response.momonga?.fallbackCauses !== undefined && response.momonga.fallbackCauses.length > 0
    ? { fallback: true, target: response.momonga.target }
    : { fallback: false };

const truncationFailure = (reported: number, observation: Pick<InputEstimate, 'estimatedTokens' | 'marginTokens'>): { code: 'input_truncated'; message: string } => ({
  code: 'input_truncated',
  message: `The server reported ${reported} input tokens for a context the token meter counts as ${observation.estimatedTokens} tokens, which is more than the estimation margin of ${observation.marginTokens} tokens below it. The server likely truncated the input without saying so. Set the server's context length to the target's context window, or lower the target's contextWindow to what the server serves.`,
});

const billedExtensionOf = (extension: MomongaResponseExtension | undefined): ModelResponse['momonga'] => {
  if (extension === undefined) return undefined;
  const { cacheWriteInputTokens, cacheReadNotReported } = extension;
  const outcome = priceOutcomeOf(extension);
  if (cacheWriteInputTokens === undefined && cacheReadNotReported === undefined && Object.keys(outcome).length === 0) return undefined;
  return {
    ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
    ...(cacheReadNotReported === undefined ? {} : { cacheReadNotReported }),
    ...outcome,
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
    if (REFUSAL_CODES.includes(result.code)) {
      journal.append([{ type: 'notice', level: 'warning', message: `The model refused the request: ${result.message}`, code: 'model_refused' }]);
      return terminals.finish('STOPPED', { stopReason: 'refusal' });
    }
    if (result.code === DEADLINE_CODE) return terminals.finish('STOPPED', { stopReason: 'timeout' });
    if (result.code === BUDGET_EXCEEDED_CODE) return stopExhausted(ctx, overCeiling(ctx.budget));
    if (result.retryable) throw new GatewayFailureError(`${result.code}: ${result.message}`);
    const terminal = terminalOf(responseFailureDisposition(result));
    return terminals.finish(terminal.to, terminal.patch);
  }
  const { response, incomplete } = result;
  const usage = response.usage;
  const fallbackDecision = fallbackOf(response);
  const answered =
    observation === undefined || (fallbackDecision.fallback && fallbackDecision.target === undefined)
      ? undefined
      : await meterFactsFor(ctx, fallbackDecision.fallback ? fallbackDecision.target : undefined);
  const answerCounter = response.momonga?.counter;
  const answeredBy = response.momonga?.target;
  const answeredTarget = answeredBy === undefined ? {} : { target: answeredBy };
  const reject = (reason: ModelRejectionReason): never => {
    journal.append([
      {
        type: 'model.rejected',
        step: position.step,
        attempt: position.attempt,
        reason,
        ...(answerCounter === undefined ? {} : { counter: answerCounter }),
        ...(answered === undefined ? {} : { meterCounter: answered.counter }),
        ...answeredTarget,
      },
      ...(usage === null
        ? []
        : [
            {
              type: 'usage.charged' as const,
              purpose: 'rejected_answer' as const,
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              totalTokens: usage.total_tokens,
              ...billedDetailOf(usage, response.momonga, timing, response.id),
              ...answeredTarget,
            },
          ]),
    ]);
    throw new GatewayFailureError(`the model response was rejected: ${reason}`);
  };
  if (usage === null) return reject('missing_usage');
  if (observation !== undefined) {
    if (answerCounter === undefined) return reject('missing_counter');
    if (answeredBy === undefined) return reject('missing_target');
    if (answered !== undefined && answerCounter !== answered.counter) return reject('counter_mismatch');
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
          input_tokens_details: wireUsageOf(usage).usage.input_tokens_details,
          output_tokens_details: { reasoning_tokens: usage.output_tokens_details.reasoning_tokens },
        },
        ...(billed === undefined ? {} : { momonga: billed }),
        timing,
      },
      ...answeredTarget,
    },
    {
      type: 'usage.updated',
      inputTokens: before.inputTokens + usage.input_tokens,
      outputTokens: before.outputTokens + usage.output_tokens,
      totalTokens: before.totalTokens + usage.total_tokens,
    },
  ];
  if (fallbackDecision.fallback && fallback?.fallbackCauses !== undefined) {
    const failed = fallback.fallbackCauses.map(describeFallbackCause);
    recorded.push({
      type: 'notice',
      level: 'warning',
      message: `The model call was answered by the fallback target ${fallback.target} because ${failed.join(' and ')}.`,
      code: 'fallback_target',
    });
  }
  for (const narrowing of response.momonga?.schemaNarrowings ?? []) {
    const key = JSON.stringify([answeredBy, narrowing.tool, narrowing.path]);
    if (ctx.memory.narrowingsNoticed.has(key)) continue;
    ctx.memory.narrowingsNoticed.add(key);
    recorded.push({
      type: 'notice',
      level: 'warning',
      message: `The tool ${narrowing.tool} was sent with its parameter at ${narrowing.path} narrowed, because the target's schema dialect cannot carry it as declared.`,
      code: 'schema_narrowed',
    });
  }
  if (estimate !== undefined && answeredBy !== undefined) {
    recorded.push({
      type: 'meter.observed',
      target: answeredBy,
      counter: estimate.counter,
      fallback: fallbackDecision.fallback,
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
  proof: AdmissionProof,
): Promise<StreamOutcome> => {
  try {
    return { kind: 'result', streamed: await streamModel(ctx, body, modelKey(ctx.run.id, position.step, position.attempt), position, proof) };
  } catch (error) {
    if (error instanceof GatewayRequestError && error.code === BUDGET_EXCEEDED_CODE) {
      delete ctx.control.inFlight.modelKey;
      return { kind: 'flow', flow: await stopExhausted(ctx, overCeiling(ctx.budget)) };
    }
    const recovery = await recoverRejectedCompaction(ctx, error, position);
    delete ctx.control.inFlight.modelKey;
    return { kind: 'flow', flow: recovery === 'done' ? 'done' : 'continue' };
  } finally {
    ctx.budget.release();
  }
};

export const resumeInFlight = async (ctx: ClaimContext): Promise<Flow> => {
  const inFlight = ctx.journal.state.inFlightModelRequest;
  if (inFlight === undefined) return 'continue';
  if (!isRequestBody(inFlight.body)) throw new Error(`the recorded model request of step ${inFlight.step} is not a response body`);
  const position = { step: inFlight.step, attempt: inFlight.attempt };
  if (ctx.control.yieldRequested()) return ctx.terminals.yieldLease();
  if (streamedBeforeRestart(ctx.journal.state, position)) ctx.journal.append([{ type: 'model.stream.restarted', step: position.step, attempt: position.attempt }]);
  const outcome = await streamRecovering(ctx, inFlight.body, position, 'recorded');
  return outcome.kind === 'flow' ? outcome.flow : handleResult(ctx, outcome.streamed, position, observationOf(inFlight.body));
};

export const isSummaryRequest = (body: CreateResponseBody): boolean => body.tool_choice === 'none';

const observationOf = (body: CreateResponseBody): InputObservation | undefined => {
  if (isSummaryRequest(body)) return undefined;
  if (!Array.isArray(body.input)) throw new Error('the model request carries no input items to check the reported tokens against');
  return { input: body.input, tools: body.tools ?? [] };
};

const loopGuidancePending = (ctx: ClaimContext): boolean => {
  if (!ctx.token.loopGuidance || ctx.journal.state.loopWarned === undefined) return false;
  const { store } = ctx.options;
  const warned = store.readRunEventsOfTypes(ctx.run.id, ['loop.warned']).at(-1);
  if (warned === undefined) throw new Error(`run ${ctx.run.id} folded a loop warning that its journal does not hold`);
  const responded = store.readLatestRunEventBefore(ctx.run.id, 'model.responded', ctx.journal.state.lastSeq + 1);
  return responded === undefined || responded.seq < warned.seq;
};

const loopGuidanceTrailing = (ctx: ClaimContext): InputItem[] => {
  if (!loopGuidancePending(ctx)) return [];
  const { state } = ctx.journal;
  if (state.loopWarned === undefined) throw new Error(`run ${ctx.run.id} has no loop warning to write guidance for`);
  const statuses = new Map<string, CallResult>(Object.entries(state.callResults));
  const ours = new Map<string, string>(
    state.history.flatMap((entry) => (entry.item.type === 'function_call_output' && entry.callId !== undefined ? [[entry.item.call_id, entry.callId] as const] : [])),
  );
  return [
    loopGuidanceItem(
      loopGuidanceFactsOf({
        state,
        signature: state.loopWarned.signature,
        resultOf: (providerCallId) => {
          const callId = ours.get(providerCallId);
          return callId === undefined ? undefined : statuses.get(callId);
        },
        isExecute: (toolName) => ctx.toolSet.get(toolName)?.kind === 'execute',
      }),
    ),
  ];
};

export const runModelStep = async (ctx: ClaimContext): Promise<Flow> => {
  const { journal, terminals, options } = ctx;
  if (options.clock.now() >= ctx.run.deadlineAt) return terminals.finish('STOPPED', { stopReason: 'timeout' });
  if (ctx.control.yieldRequested()) return terminals.yieldLease();
  const quote = await quoteFor(ctx.budget, ctx.model);
  const trailing = loopGuidanceTrailing(ctx);
  let exhausted = stepsExhausted(journal.state.step, ctx.limits.maxSteps);
  let outcome = await buildNext(ctx, { ...(exhausted === undefined ? {} : { wrapUp: stopReasonOf(exhausted) }), trailing });
  if (outcome.kind === 'done') return 'done';
  let admission = admissionOf(ctx, outcome.built, quote);
  if (admission.kind === 'exhausted' && exhausted === undefined && outcome.wrapUp === undefined && admission.exhausted.cause !== 'unpriced') {
    exhausted = admission.exhausted;
    outcome = await buildNext(ctx, { wrapUp: stopReasonOf(exhausted), trailing });
    if (outcome.kind === 'done') return 'done';
    admission = admissionOf(ctx, outcome.built, quote);
  }
  if (admission.kind === 'lease_lost') return terminals.yieldLease();
  if (admission.kind === 'exhausted') return stopExhausted(ctx, exhausted ?? admission.exhausted);
  const { built, wrapUp } = outcome;
  const summarising = exhausted !== undefined || wrapUp !== undefined;
  const step = journal.state.step + 1;
  const plainBody: CreateResponseBody = {
    model: ctx.model,
    input: built.input,
    tools: built.tools,
    ...(summarising ? { tool_choice: 'none' as const } : ctx.toolLess ? {} : { tool_choice: 'auto' as const }),
    ...(ctx.capabilities.parallelToolCalls === undefined || ctx.toolLess ? {} : { parallel_tool_calls: ctx.capabilities.parallelToolCalls }),
    ...(summarising ? { reasoning: { effort: LOWEST_REASONING_EFFORT } } : {}),
    ...outputBoundOf(ctx.capabilities, admission.maxOutputTokens),
    store: false,
    stream: true,
    metadata: { run_id: ctx.run.id, step: String(step) },
  };
  if ((await cancelIfInterrupted(ctx)) === 'done') return 'done';
  const position = { step, attempt: 1 };
  const prefixRecord = recordPrefix(ctx, built, summarising);
  const cacheControls = cacheControlsOf(ctx, built, prefixRecord?.prefix);
  const body: CreateResponseBody = { ...plainBody, ...cacheControls, momonga: { ...cacheControls.momonga, ...EXACT_MODEL, ...ceilingOf(admission) } };
  const proof = requestBudgetOf(admission, quote);
  const requestOffered = offeredRecordFor(journal.state.offeredTools, built.tools.map((tool) => tool.name));
  journal.append([
    ...(requestOffered === undefined ? [] : [requestOffered]),
    ...(wrapUp === undefined ? [] : [{ type: 'notice' as const, level: 'error' as const, message: wrapUp.notice, code: 'context_wrap_up' }]),
    ...(prefixRecord === undefined ? [] : prefixRecord.notices),
    ...(exhausted === undefined ? [] : [{ type: 'budget.exhausted' as const, ...exhausted }]),
    {
      type: 'model.requested',
      step: position.step,
      attempt: position.attempt,
      digest: sha256Hex(canonicalJson(body)),
      pinnedDigest: pinnedDigestOf(body),
      body,
      anatomy: built.anatomy,
      ...(prefixRecord === undefined ? {} : { prefix: prefixRecord.prefix }),
      budget: proof,
    },
  ]);
  const streamed = await streamRecovering(ctx, body, position, proof);
  return streamed.kind === 'flow'
    ? streamed.flow
    : handleResult(ctx, streamed.streamed, position, observationOf(body));
};
