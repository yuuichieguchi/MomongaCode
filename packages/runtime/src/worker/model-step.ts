import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { CreateResponseBody, InputItem, RunState } from '@momonga/protocol';
import type { ClaimContext, Flow } from './claim-context.ts';
import { GatewayFailureError } from './errors.ts';
import { isRecord } from './json.ts';
import { buildNext, cancelIfInterrupted } from './context-step.ts';
import { isLoop } from './loop-detection.ts';
import { streamModel } from './model-stream.ts';
import type { ModelResult } from './model-stream.ts';
import { recordCalls, settleCalls } from './tool-step.ts';

const MODEL_ATTEMPT = 1;
const DEADLINE_CODE = 'deadline_exceeded';
const RESTART_SCAN_CHUNK = 1000;
const REFUSAL_CODES = ['guardrail_violation', 'refusal', 'content_filter'];

type LimitReason = 'max_steps' | 'budget';

const isRequestBody = (value: unknown): value is CreateResponseBody => isRecord(value) && typeof value['model'] === 'string';

export const modelKey = (runId: string, step: number, attempt: number): string => sha256Hex(canonicalJson([runId, step, attempt]));

const summaryInstruction = (reason: LimitReason): string =>
  `You have reached the ${reason} limit. Summarize what you accomplished, what remains, and any state the user must know. Do not call tools.`;

const limitReached = (ctx: ClaimContext): LimitReason | undefined => {
  const state = ctx.journal.state;
  if (state.step >= ctx.limits.maxSteps) return 'max_steps';
  if (state.usage.totalTokens >= ctx.limits.maxTotalTokens) return 'budget';
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
    return terminals.finish('STOPPED', { stopReason: response.step - 1 >= ctx.limits.maxSteps ? 'max_steps' : 'budget' });
  }
  if (response.refusal) return terminals.finish('STOPPED', { stopReason: 'refusal' });
  if (response.callIds.length === 0) {
    if (response.incomplete) return incompleteFailure(response.incompleteReason, terminals);
    return terminals.finish('COMPLETED');
  }
  if (isLoop(journal.state.history, ctx.limits.loopThreshold)) {
    journal.append([
      { type: 'notice', level: 'warning', message: `The model repeated the same tool call with the same results ${ctx.limits.loopThreshold} times in a row, so the run stops.` },
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
      journal.append([{ type: 'notice', level: 'warning', message: `The model refused the request: ${result.message}` }]);
      return terminals.finish('STOPPED', { stopReason: 'refusal' });
    }
    if (result.code === DEADLINE_CODE) return terminals.finish('STOPPED', { stopReason: 'timeout' });
    throw new GatewayFailureError(`${result.code ?? 'error'}: ${result.message}`);
  }
  const { response, incomplete } = result;
  const usage = response.usage;
  if (usage === null) throw new GatewayFailureError('the model response carries no usage');
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
  if (observation !== undefined) ctx.meter.observe({ inputDigest: observation.inputDigest, inputTokens: usage.input_tokens });
  return decideAfterResponse(ctx);
};

const DELTA_TYPES: readonly string[] = ['agent.message.delta', 'agent.thought.delta'];

const streamedBeforeRestart = (ctx: ClaimContext, position: { step: number; attempt: number }, requestedSeq: number): boolean => {
  let streamed = false;
  for (let after = requestedSeq; ; ) {
    const events = ctx.options.store.readRunEvents(ctx.run.id, after, RESTART_SCAN_CHUNK);
    for (const event of events) {
      if (event.type === 'model.stream.restarted' && event.step === position.step && event.attempt === position.attempt) streamed = false;
      else if (DELTA_TYPES.includes(event.type) && 'attempt' in event && event.step === position.step && event.attempt === position.attempt) streamed = true;
    }
    if (events.length < RESTART_SCAN_CHUNK) return streamed;
    after = events[events.length - 1]?.seq ?? after;
  }
};

export const resumeInFlight = async (ctx: ClaimContext): Promise<Flow> => {
  const inFlight = ctx.journal.state.inFlightModelRequest;
  if (inFlight === undefined) return 'continue';
  if (!isRequestBody(inFlight.body)) throw new Error(`the recorded model request of step ${inFlight.step} is not a response body`);
  const position = { step: inFlight.step, attempt: inFlight.attempt };
  if (ctx.control.yieldRequested()) return ctx.terminals.yieldLease();
  if (streamedBeforeRestart(ctx, position, inFlight.requestedSeq)) ctx.journal.append([{ type: 'model.stream.restarted', step: position.step, attempt: position.attempt }]);
  const result = await streamModel(ctx, inFlight.body, modelKey(ctx.run.id, position.step, position.attempt), position);
  return handleResult(ctx, result, position, undefined);
};

export const runModelStep = async (ctx: ClaimContext): Promise<Flow> => {
  const { journal, terminals, options } = ctx;
  if (options.clock.now() >= ctx.run.deadlineAt) return terminals.finish('STOPPED', { stopReason: 'timeout' });
  if (ctx.control.yieldRequested()) return terminals.yieldLease();
  const limit = limitReached(ctx);
  const outcome = await buildNext(ctx);
  if (outcome.kind === 'done') return 'done';
  const { built } = outcome;
  const input: InputItem[] =
    limit === undefined ? built.input : [...built.input, { type: 'message', role: 'developer', content: summaryInstruction(limit) }];
  const step = journal.state.step + 1;
  const body: CreateResponseBody = {
    model: ctx.alias,
    input,
    tools: built.tools,
    tool_choice: limit === undefined ? 'auto' : 'none',
    parallel_tool_calls: ctx.capabilities.parallelToolCalls,
    max_output_tokens: built.maxOutputTokens,
    store: false,
    stream: true,
    metadata: { run_id: ctx.run.id, step: String(step) },
  };
  if (cancelIfInterrupted(ctx) === 'done') return 'done';
  const position = { step, attempt: MODEL_ATTEMPT };
  journal.append([{ type: 'model.requested', step: position.step, attempt: position.attempt, digest: sha256Hex(canonicalJson(body)), body }]);
  const result = await streamModel(ctx, body, modelKey(ctx.run.id, position.step, position.attempt), position);
  return handleResult(ctx, result, position, limit === undefined ? { inputDigest: built.inputDigest } : undefined);
};
