import { ContextOverflowError, PinnedOverflowError, PinnedRoomError, budgetFor, buildContext, measurePinned } from '@momonga/context';
import type { BuildContextInput, BuildContextPorts, BuiltContext, CompactionPlan, ContextEviction, PinnedMeasure } from '@momonga/context';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import { compactionSummaryMessage, decodeCompactionSummary, userMessageContent } from '@momonga/protocol';
import type { CompactRequest, ContentPart, RunEventPayload } from '@momonga/protocol';
import { GatewayRequestError } from '../gateway-client.ts';
import type { ClaimContext } from './claim-context.ts';
import { touchedPathsOf } from './touched-paths.ts';
import { wrapUpInstructionFor } from './wrap-up.ts';
import type { WrapUpReason } from './wrap-up.ts';

export type BuildOutcome =
  | { kind: 'built'; built: BuiltContext; wrapUp?: { reason: 'context'; notice: string } }
  | { kind: 'done' };

const ESCALATING_CODES: readonly string[] = [
  'compaction_input_too_large',
  'compaction_summary_too_long',
  'compaction_invalid_reply',
  'invalid_summary_cap',
  'content_filter',
  'guardrail_violation',
  'refusal',
];
const NON_ESCALATING_4XX: readonly number[] = [401, 403, 404, 408, 409, 429];
const PROACTIVE_SUPPRESSED_STEPS = 3;

const escalates = (error: unknown): error is GatewayRequestError =>
  error instanceof GatewayRequestError &&
  error.code !== 'invalid_compaction' &&
  (ESCALATING_CODES.includes(error.code) || (error.status >= 400 && error.status < 500 && !NON_ESCALATING_4XX.includes(error.status)));

const sessionOf = (ctx: ClaimContext) => {
  const session = ctx.options.store.getSession(ctx.run.sessionId);
  if (session === undefined) throw new Error(`unknown session ${ctx.run.sessionId}`);
  return session;
};

const taskContentOf = (ctx: ClaimContext): ContentPart[] => {
  const [first] = ctx.options.store.readRunEvents(ctx.run.id, 0, 1);
  if (first === undefined || first.type !== 'user.message') throw new Error(`run ${ctx.run.id} does not start with a user message`);
  return userMessageContent(first.text, first.images);
};

export const contextInputOf = (ctx: ClaimContext, wrapUp: WrapUpReason | undefined, level: number): BuildContextInput => {
  const { options, journal } = ctx;
  const state = journal.state;
  const session = sessionOf(ctx);
  return {
    capabilities: ctx.capabilities,
    model: ctx.alias,
    sources: {
      systemPrompt: ctx.systemPrompt,
      tools: ctx.functionTools,
      task: { type: 'message', role: 'user', content: taskContentOf(ctx) },
      taskSeq: state.taskSeq,
      ...(ctx.skills.catalog === undefined ? {} : { skillCatalog: ctx.skills.catalog }),
      activatedSkills: state.activatedSkills,
      memories: ctx.recalled.memories,
      history: state.history
        .filter((entry) => entry.seq !== state.taskSeq)
        .map((entry) => ({ seq: entry.seq, item: entry.item, ...(entry.handle === undefined ? {} : { handle: entry.handle }) })),
      ...(state.summary === undefined ? {} : { summary: { item: state.summary.item, replacedThroughSeq: state.summary.replacedThroughSeq } }),
    },
    evicted: new Set(state.evicted),
    touchedPaths: touchedPathsOf(state.history, session.cwd),
    trusted: options.settings.trusted(session),
    projectRoot: session.cwd,
    home: options.home,
    level,
    ...(ctx.pinnedDigest.value === undefined ? {} : { expectedPinnedDigest: ctx.pinnedDigest.value }),
    ...(wrapUp === undefined ? {} : { tools: 'none' as const, trailing: [{ type: 'message' as const, role: 'user' as const, content: wrapUpInstructionFor(wrapUp) }] }),
  };
};

const portsOf = (ctx: ClaimContext): BuildContextPorts => ({
  meter: ctx.meter,
  blobs: {
    handleFor: (content) => ctx.options.blobs.handleFor(content),
    put: async (text, blobOptions) => ctx.options.blobs.put(text, blobOptions),
  },
  instructions: ctx.options.instructionReader,
});

export const measurePinnedFor = (ctx: ClaimContext): Promise<PinnedMeasure> => measurePinned(contextInputOf(ctx, undefined, 0), portsOf(ctx));

const buildOnce = async (ctx: ClaimContext, wrapUp: WrapUpReason | undefined, level: number): Promise<BuiltContext> => {
  const built = await buildContext(contextInputOf(ctx, wrapUp, level), portsOf(ctx));
  if (wrapUp === undefined) ctx.pinnedDigest.value ??= built.pinnedDigest;
  return built;
};

export const compactThrough = async (ctx: ClaimContext, plan: Pick<CompactionPlan, 'throughSeq' | 'input' | 'summaryTokenCap'>): Promise<void> => {
  const { journal, options } = ctx;
  const request: CompactRequest = {
    model: ctx.alias,
    input: plan.input,
    momonga: { max_summary_tokens: plan.summaryTokenCap, retains_user_request: true },
  };
  const idempotencyKey = sha256Hex(canonicalJson([ctx.run.id, 'compact', sha256Hex(canonicalJson(request))]));
  ctx.control.inFlight.compactionKey = idempotencyKey;
  const resource = await ctx.control.recordingRaised(
    options.gateway.compact(request, {
      idempotencyKey,
      deadlineAt: ctx.run.deadlineAt,
      signal: ctx.control.signal,
      traceparent: ctx.agentSpan.traceparent,
    }),
  );
  delete ctx.control.inFlight.compactionKey;
  const compaction = resource.output.find((item) => item.type === 'compaction');
  if (compaction === undefined) throw new Error(`the compaction response for run ${ctx.run.id} holds no compaction item`);
  journal.append([
    {
      type: 'context.compacted',
      item: { type: 'compaction', id: compaction.id, encrypted_content: compaction.encrypted_content },
      summary: decodeCompactionSummary(compaction.encrypted_content) ?? '',
      replacedThroughSeq: plan.throughSeq,
    },
  ]);
};

const interrupted = (ctx: ClaimContext): boolean => ctx.control.signal.aborted || ctx.control.cancelRequested();

export const cancelIfInterrupted = (ctx: ClaimContext): 'done' | undefined => {
  const failure = ctx.control.failure();
  if (failure !== undefined) throw failure;
  if (ctx.control.leaseLost()) ctx.control.lost();
  if (ctx.control.shuttingDown()) return ctx.terminals.yieldLease();
  return interrupted(ctx) ? ctx.terminals.cancel() : undefined;
};

const recordContextFacts = (ctx: ClaimContext, built: BuiltContext): void => {
  const known = new Set(ctx.journal.state.notes.map((note) => note.message));
  const payloads: RunEventPayload[] = [];
  for (const notice of built.notices) {
    if (known.has(notice.message)) continue;
    known.add(notice.message);
    payloads.push({ type: 'notice', level: 'warning', message: notice.message });
  }
  for (const instruction of built.loadedInstructions) {
    const recorded = ctx.journal.state.loadedInstructions.find((entry) => entry.path === instruction.path);
    if (recorded?.textSha256 === instruction.textSha256) continue;
    payloads.push({ type: 'instructions.loaded', path: instruction.path, content: instruction.text });
  }
  if (payloads.length > 0) ctx.journal.append(payloads);
  const unmarked = built.loadedMemoryIds.filter((id) => !ctx.usedMemoryIds.has(id));
  if (unmarked.length > 0) {
    ctx.recalled.markUsed(unmarked);
    for (const id of unmarked) ctx.usedMemoryIds.add(id);
  }
};

const recordEvictions = (ctx: ClaimContext, evictions: readonly ContextEviction[]): void => {
  const state = ctx.journal.state;
  const unreflected = evictions.filter((eviction) => {
    const entry = state.history.find((candidate) => candidate.callId === eviction.callId && candidate.item.type === 'function_call_output');
    if (entry === undefined) return false;
    return eviction.kind === 'omitted' ? !state.evicted.includes(eviction.callId) : entry.handle === undefined;
  });
  if (unreflected.length === 0) return;
  ctx.journal.append(unreflected.map((eviction) => ({ type: 'context.truncated', callId: eviction.callId, handle: eviction.handle, kind: eviction.kind })));
};

export const recoverRejectedCompaction = (ctx: ClaimContext, error: unknown, position?: { step: number; attempt: number }): 'recovered' | 'done' => {
  const summary = ctx.journal.state.summary;
  if (!(error instanceof GatewayRequestError) || error.code !== 'invalid_compaction' || summary?.item.type !== 'compaction') throw error;
  if (summary.summary === '') {
    ctx.terminals.finish('FAILED', {
      error: {
        code: 'compaction_unverifiable',
        message: 'The gateway rejected the compaction item of this run and its summary text was not recorded, so the conversation cannot be rebuilt.',
      },
    });
    return 'done';
  }
  ctx.journal.append([{ type: 'context.compaction_rejected', ...(position ?? {}), item: compactionSummaryMessage(summary.summary) }]);
  return 'recovered';
};

export const pinnedOverflowFailure = (ctx: ClaimContext, error: PinnedOverflowError): { code: 'pinned_overflow'; message: string } => {
  const { W, R } = budgetFor(ctx.capabilities, 0);
  if (error instanceof PinnedRoomError) {
    return {
      code: 'pinned_overflow',
      message: `The pinned context fits (${error.pinnedTokens} of ${error.ceiling} tokens) but leaves only ${error.room} tokens for the conversation; at least ${error.minimum} are needed for one tool call, one tool result and a summary. Reduce the fixed prefix (deny rules for unused tools, plan mode, shorter instructions) or use a larger window.`,
    };
  }
  const { systemPrompt, tools, instructions, task } = error.breakdown;
  const percent = error.pinnedTokens === 0 ? 0 : Math.round((100 * tools) / error.pinnedTokens);
  return {
    code: 'pinned_overflow',
    message: `The pinned context needs ${error.pinnedTokens} tokens but at most ${error.ceiling} fit (window ${W}, output reserve ${R}, estimation margin ${W - R - error.ceiling}). Breakdown: system prompt ${systemPrompt}, tool definitions ${tools} (${percent}%), instructions ${instructions}, task ${task}. Reduce it with deny rules for tools you do not need, \`plan\` mode, a shorter task or AGENTS.md, or a model with a larger context window.`,
  };
};

type FinalAttempt = {
  successes: number;
  attempts: number;
  failures: { code: string; message: string }[];
  triedAtLastLevel: boolean;
};

const protectionClause = (error: ContextOverflowError): string => {
  const { keepTurns, keepSteps } = error.protection;
  return error.level === 0
    ? `protection was not reduced (${keepTurns} turn(s) and ${keepSteps} step(s) kept)`
    : `protection was reduced to ${keepTurns} turn(s) and ${keepSteps} step(s)`;
};

const budgetStopNotice = (ctx: ClaimContext, error: ContextOverflowError, attempt: FinalAttempt, wrapUpClause: string): string => {
  const { W, R } = budgetFor(ctx.capabilities, 0);
  const breakdown = error.breakdown;
  const prefix =
    breakdown === undefined
      ? `${error.pinnedTokens}`
      : `${error.pinnedTokens} (system prompt ${breakdown.systemPrompt}, tool definitions ${breakdown.tools}, instructions ${breakdown.instructions}, task ${breakdown.task})`;
  const failures =
    attempt.failures.length === 0 ? '' : `, ${attempt.failures.length} failed (${attempt.failures.map((failure) => `${failure.code}: ${failure.message}`).join('; ')})`;
  const reason =
    error.compactionBlockedBy?.message ??
    (attempt.triedAtLastLevel ? 'the compaction at this level did not free enough room' : 'no compaction was available');
  return (
    `The context needs ${error.inputTokens} tokens but at most ${error.ceiling} fit (window ${W}, output reserve ${R}, estimation margin ${W - R - error.ceiling}). ` +
    `The fixed prefix takes ${prefix}. ` +
    `Earlier in this run: ${ctx.journal.state.evicted.length} tool outputs were replaced by handles and ${ctx.journal.countRecorded('context.compacted') - attempt.successes} compaction(s) were recorded. ` +
    `Final attempt: ${attempt.attempts} compaction(s) ran${failures}; no further compaction was possible because ${reason}; ` +
    `${protectionClause(error)}; ${wrapUpClause}.`
  );
};

export const buildNext = async (ctx: ClaimContext, options: { wrapUp?: WrapUpReason } = {}): Promise<BuildOutcome> => {
  const step = ctx.journal.state.step + 1;
  const attempt: FinalAttempt = { successes: 0, attempts: 0, failures: [], triedAtLastLevel: false };
  const levelsWithCompaction = new Set<number>();
  let proactiveDone = false;
  let level = 0;

  const compact = async (plan: CompactionPlan): Promise<'compacted' | 'retry' | 'done'> => {
    attempt.attempts += 1;
    try {
      await compactThrough(ctx, plan);
      attempt.successes += 1;
      return 'compacted';
    } catch (error) {
      if (error instanceof GatewayRequestError) delete ctx.control.inFlight.compactionKey;
      if (error instanceof GatewayRequestError && error.code === 'invalid_compaction') {
        attempt.attempts -= 1;
        return recoverRejectedCompaction(ctx, error) === 'done' ? 'done' : 'retry';
      }
      throw error;
    }
  };

  const stop = (error: ContextOverflowError, clause: string): BuildOutcome => {
    ctx.journal.append([{ type: 'notice', level: 'error', message: budgetStopNotice(ctx, error, attempt, clause) }]);
    ctx.terminals.finish('STOPPED', { stopReason: 'budget' });
    return { kind: 'done' };
  };

  for (;;) {
    if (cancelIfInterrupted(ctx) === 'done') return { kind: 'done' };
    let built: BuiltContext;
    try {
      built = await buildOnce(ctx, options.wrapUp, level);
    } catch (error) {
      if (error instanceof PinnedOverflowError) {
        ctx.terminals.finish('FAILED', { error: pinnedOverflowFailure(ctx, error) });
        return { kind: 'done' };
      }
      if (error instanceof GatewayRequestError && error.code === 'invalid_compaction') {
        if (recoverRejectedCompaction(ctx, error) === 'done') return { kind: 'done' };
        continue;
      }
      if (!(error instanceof ContextOverflowError)) throw error;
      if (error.compaction !== undefined && !levelsWithCompaction.has(level)) {
        levelsWithCompaction.add(level);
        if (cancelIfInterrupted(ctx) === 'done') return { kind: 'done' };
        try {
          const result = await compact(error.compaction);
          if (result === 'done') return { kind: 'done' };
          if (result === 'retry') levelsWithCompaction.delete(level);
          if (error.lastLevel) attempt.triedAtLastLevel = true;
          continue;
        } catch (failure) {
          if (!escalates(failure)) throw failure;
          attempt.failures.push({ code: failure.code, message: failure.message });
          if (error.lastLevel) attempt.triedAtLastLevel = true;
        }
      }
      if (!error.lastLevel) {
        level += 1;
        continue;
      }
      recordEvictions(ctx, error.evictions);
      if (options.wrapUp !== undefined) return stop(error, 'the final summary request does not fit either');
      let wrapUpBuilt: BuiltContext;
      try {
        wrapUpBuilt = await buildOnce(ctx, 'context', error.level);
      } catch (wrapUpError) {
        if (wrapUpError instanceof ContextOverflowError || wrapUpError instanceof PinnedOverflowError) {
          return stop(error, 'the context does not fit even without tools, so no final summary was requested');
        }
        throw wrapUpError;
      }
      if (cancelIfInterrupted(ctx) === 'done') return { kind: 'done' };
      recordContextFacts(ctx, wrapUpBuilt);
      recordEvictions(ctx, wrapUpBuilt.evictions);
      return { kind: 'built', built: wrapUpBuilt, wrapUp: { reason: 'context', notice: budgetStopNotice(ctx, error, attempt, 'a final summary was requested') } };
    }
    if (cancelIfInterrupted(ctx) === 'done') return { kind: 'done' };
    if (built.compaction !== undefined && options.wrapUp === undefined && level === 0 && !proactiveDone && step > ctx.compaction.suppressedUntilStep) {
      proactiveDone = true;
      try {
        const result = await compact(built.compaction);
        if (result === 'done') return { kind: 'done' };
        if (result === 'retry') proactiveDone = false;
        continue;
      } catch (failure) {
        if (!escalates(failure)) throw failure;
        ctx.compaction.suppressedUntilStep = step + PROACTIVE_SUPPRESSED_STEPS;
        ctx.journal.append([
          { type: 'notice', level: 'warning', message: `Compaction failed (${failure.code}): ${failure.message}; continuing without it` },
        ]);
      }
    }
    recordContextFacts(ctx, built);
    recordEvictions(ctx, built.evictions);
    return { kind: 'built', built };
  }
};
