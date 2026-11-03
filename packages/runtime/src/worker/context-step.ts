import {
  ContextOverflowError,
  PinnedOverflowError,
  PinnedRoomError,
  budgetFor,
  buildContext,
  checkSummary,
  criticalIdentifiersOf,
  measureLayers,
  measurePinned,
  renderWorkingState,
  textOfItem,
  workingStateCapFor,
} from '@momonga/context';
import type { ActivatedSkill, BuildContextInput, BuildContextPorts, BuiltContext, CompactionPlan, ContextEviction, LoadedGoverning, PinnedMeasure, TouchedPath } from '@momonga/context';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import { resolveGoverning } from '@momonga/memory';
import type { Session } from '@momonga/store';
import { compactionSummaryMessage, decodeCompactionSummary, tokensForText, userMessageContent } from '@momonga/protocol';
import type { CompactRequest, CompactResource, CompactionInputItem, ContentPart, MessageInputItem, RunEvent, RunEventPayload, RunState, SummaryFidelity } from '@momonga/protocol';
import { foldRunState } from '@momonga/store';
import { GatewayRequestError } from '../gateway-client.ts';
import { recallQueryOf } from '../memory/recall-query.ts';
import type { WorkerBlobs } from './types.ts';
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
const NO_ADOPTED_GUIDELINE = 0;
const MAX_NAMED_TOKENS = 5;
const AUTO_COMPACT_OFF_REASON = 'compaction is off (context.autoCompact is false)';

const escalates = (error: unknown): error is GatewayRequestError =>
  error instanceof GatewayRequestError &&
  error.code !== 'invalid_compaction' &&
  (ESCALATING_CODES.includes(error.code) || (error.status >= 400 && error.status < 500 && !NON_ESCALATING_4XX.includes(error.status)));

const sessionOf = (ctx: ClaimContext) => {
  const session = ctx.options.store.getSession(ctx.run.sessionId);
  if (session === undefined) throw new Error(`unknown session ${ctx.run.sessionId}`);
  return session;
};

const taskOf = (ctx: ClaimContext): { content: ContentPart[]; text: string } => {
  const [first] = ctx.options.store.readRunEvents(ctx.run.id, 0, 1);
  if (first === undefined || first.type !== 'user.message') throw new Error(`run ${ctx.run.id} does not start with a user message`);
  return { content: userMessageContent(first.text, first.images), text: first.text };
};

type GoverningScan = 'active' | 'live';

const governingFor = (ctx: ClaimContext, session: Session, touched: readonly TouchedPath[], scan: GoverningScan) =>
  resolveGoverning(ctx.options.store.governing.list({ project: session.cwd }), {
    now: ctx.options.clock.now(),
    project: session.cwd,
    touchedPaths: [...touched.map((entry) => entry.path), ctx.options.tools.sessionState(session).cwd],
    ...(scan === 'live' ? { ignorePaths: true } : {}),
  });

const governingKeyOf = (governing: LoadedGoverning): string => canonicalJson({ active: governing.active, conflicts: governing.conflicts });

const EMPTY_GOVERNING: LoadedGoverning = { active: [], conflicts: [] };

const workingStateOf = (ctx: ClaimContext, state: RunState): string | undefined =>
  state.summary === undefined
    ? undefined
    : renderWorkingState(state, { capTokens: workingStateCapFor(ctx.capabilities), tokensOf: tokensForText, verificationCommands: ctx.verificationCommands });

const projectedWorkingStateOf = (ctx: ClaimContext, state: RunState): string | undefined =>
  state.history.length === 0 ? undefined : workingStateOf(ctx, projectCompaction(ctx, state.nextItemSeq - 1, compactionSummaryMessage(''), ''));

export const contextInputOf = (ctx: ClaimContext, wrapUp: WrapUpReason | undefined, level: number, scan: GoverningScan = 'active'): BuildContextInput => {
  const { options, journal } = ctx;
  const state = journal.state;
  const session = sessionOf(ctx);
  const workingState = workingStateOf(ctx, state);
  const projectedWorkingState = projectedWorkingStateOf(ctx, state);
  const task = taskOf(ctx);
  const touchedPaths = touchedPathsOf(state.workingFacts.touched, session.cwd);
  return {
    capabilities: ctx.capabilities,
    model: ctx.alias,
    sources: {
      systemPrompt: ctx.systemPrompt,
      tools: ctx.functionTools(),
      task: { type: 'message', role: 'user', content: task.content },
      taskSeq: state.taskSeq,
      ...(ctx.skills.catalog === undefined ? {} : { skillCatalog: ctx.skills.catalog }),
      activatedSkills: state.activatedSkills,
      governing: governingFor(ctx, session, touchedPaths, scan),
      memories: ctx.recalled.rank(recallQueryOf(task.text, touchedPaths.map((entry) => entry.path), session.cwd)),
      history: state.history
        .filter((entry) => entry.seq !== state.taskSeq)
        .map((entry) => ({ seq: entry.seq, item: entry.item, ...(entry.handle === undefined ? {} : { handle: entry.handle }) })),
      ...(state.summary === undefined ? {} : { summary: { item: state.summary.item, replacedThroughSeq: state.summary.replacedThroughSeq } }),
      ...(workingState === undefined ? {} : { workingState }),
      ...(projectedWorkingState === undefined ? {} : { projectedWorkingState }),
    },
    companions: ctx.companions(),
    evicted: new Set(state.evicted),
    ...(ctx.memoryShare === undefined ? {} : { memoryShare: ctx.memoryShare }),
    touchedPaths,
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
    put: async (text, blobOptions) => ctx.options.blobs.put(text, { ...blobOptions, runId: ctx.run.id }),
  },
  instructions: ctx.options.instructionReader,
});

export const measurePinnedFor = (ctx: ClaimContext): Promise<PinnedMeasure> => measurePinned(contextInputOf(ctx, undefined, 0), portsOf(ctx));

export const measureLayersWith = (ctx: ClaimContext, activatedSkills: readonly ActivatedSkill[]): Promise<void> => {
  const input = contextInputOf(ctx, undefined, 0);
  return measureLayers({ ...input, sources: { ...input.sources, activatedSkills } }, portsOf(ctx));
};

const buildOnce = async (ctx: ClaimContext, wrapUp: WrapUpReason | undefined, level: number): Promise<BuiltContext> => {
  const built = await buildContext(contextInputOf(ctx, wrapUp, level), portsOf(ctx));
  if (wrapUp === undefined) ctx.pinnedDigest.value ??= built.pinnedDigest;
  return built;
};

type CompactedPayload = Extract<RunEventPayload, { type: 'context.compacted' }>;
type CompactedEvent = Extract<RunEvent, { type: 'context.compacted' }>;
type CompactionSource = Pick<CompactionPlan, 'throughSeq' | 'input' | 'summaryTokenCap' | 'pinnedText'>;

const wholeBlobText = async (blobs: WorkerBlobs, handle: string, scope: { runId: string }): Promise<string> => {
  const { totalBytes } = await blobs.read(handle, { offset: 0, length: 0 }, scope);
  return (await blobs.read(handle, { offset: 0, length: totalBytes }, scope)).text;
};

type RegionText = { text: string; unreadable: { handle: string; reason: string }[] };

const replacedRegionText = async (ctx: ClaimContext, plan: CompactionSource): Promise<RegionText> => {
  const replaced = ctx.journal.state.history.filter((entry) => entry.seq <= plan.throughSeq);
  const unreadable: RegionText['unreadable'] = [];
  const recorded = await Promise.all(
    replaced.map(async (entry) => {
      if (entry.handle === undefined || entry.item.type !== 'function_call_output') return textOfItem(entry.item);
      const { handle } = entry;
      try {
        return await wholeBlobText(ctx.options.blobs, handle, { runId: ctx.run.id });
      } catch (error) {
        unreadable.push({ handle, reason: error instanceof Error ? error.message : String(error) });
        return textOfItem(entry.item);
      }
    }),
  );
  return { text: [...recorded, ...plan.input.map((item) => textOfItem(item))].join('\n'), unreadable };
};

const noticeOf = (code: string, message: string): RunEventPayload => ({ type: 'notice', level: 'warning', message, code });

const fittingHead = (text: string, maxTokens: number): string => {
  if (tokensForText(text) <= maxTokens) return text;
  const marker = ' [… cut]';
  let kept = 0;
  let tooLong = text.length;
  while (tooLong - kept > 1) {
    const middle = Math.floor((kept + tooLong) / 2);
    if (tokensForText(`${text.slice(0, middle)}${marker}`) <= maxTokens) kept = middle;
    else tooLong = middle;
  }
  return `${text.slice(0, kept)}${marker}`;
};

const projectCompaction = (ctx: ClaimContext, throughSeq: number, item: CompactionInputItem | MessageInputItem, summary: string): RunState => {
  const state = ctx.journal.state;
  const event: CompactedEvent = {
    type: 'context.compacted',
    item,
    summary,
    replacedThroughSeq: throughSeq,
    id: 0,
    runId: state.runId,
    sessionId: state.sessionId,
    seq: state.lastSeq + 1,
    step: state.step,
    leaseToken: 0,
    createdAt: 0,
  };
  return foldRunState(state, event);
};

const renderedFacts = (ctx: ClaimContext, projected: RunState, capTokens: number): string => {
  const text = renderWorkingState(projected, { capTokens, tokensOf: tokensForText, verificationCommands: ctx.verificationCommands });
  if (text === undefined) throw new Error(`run ${projected.runId} has no summary after a projected compaction`);
  return text;
};

const deterministicCompaction = (ctx: ClaimContext, plan: CompactionSource, guidelineVersion: number, fidelity?: SummaryFidelity): CompactedPayload => {
  const projected = projectCompaction(ctx, plan.throughSeq, compactionSummaryMessage(''), '');
  const facts = renderedFacts(ctx, projected, Math.min(plan.summaryTokenCap, workingStateCapFor(ctx.capabilities)));
  const previous = ctx.journal.state.summary?.summary ?? '';
  const room = plan.summaryTokenCap - tokensForText(facts) - 1;
  const summary = previous === '' || room <= 0 ? facts : `${fittingHead(previous, room)}\n${facts}`;
  return {
    type: 'context.compacted',
    item: compactionSummaryMessage(summary),
    summary,
    replacedThroughSeq: plan.throughSeq,
    source: 'deterministic',
    ...(fidelity === undefined ? {} : { fidelity }),
    guidelineVersion,
  };
};

export const compactThrough = async (ctx: ClaimContext, plan: CompactionSource): Promise<void> => {
  const { journal, options } = ctx;
  const request: CompactRequest = {
    model: ctx.alias,
    input: plan.input,
    momonga: { max_summary_tokens: plan.summaryTokenCap, retains_user_request: true, ...(ctx.guideline === undefined ? {} : { guideline: ctx.guideline.text }) },
  };
  const guidelineVersion = ctx.guideline?.version ?? NO_ADOPTED_GUIDELINE;
  const idempotencyKey = sha256Hex(canonicalJson([ctx.run.id, 'compact', sha256Hex(canonicalJson(request))]));
  ctx.control.inFlight.compactionKey = idempotencyKey;
  let resource: CompactResource;
  try {
    resource = await ctx.control.recordingRaised(
      options.gateway.compact(request, {
        idempotencyKey,
        deadlineAt: ctx.run.deadlineAt,
        signal: ctx.control.signal,
        traceparent: ctx.agentSpan.traceparent,
      }),
    );
  } catch (error) {
    if (!escalates(error)) throw error;
    delete ctx.control.inFlight.compactionKey;
    journal.append([
      noticeOf('compaction_failed', `Compaction summary failed (${error.code}): ${error.message}; the deterministic summary was used`),
      deterministicCompaction(ctx, plan, NO_ADOPTED_GUIDELINE),
    ]);
    return;
  }
  delete ctx.control.inFlight.compactionKey;
  const compaction = resource.output.find((item) => item.type === 'compaction');
  if (compaction === undefined) throw new Error(`the compaction response for run ${ctx.run.id} holds no compaction item`);
  const item: CompactionInputItem = { type: 'compaction', id: compaction.id, encrypted_content: compaction.encrypted_content };
  const summary = decodeCompactionSummary(compaction.encrypted_content) ?? '';
  const projected = projectCompaction(ctx, plan.throughSeq, item, summary);
  const region = await replacedRegionText(ctx, plan);
  const fidelity = checkSummary(summary, {
    region: region.text,
    pinned: plan.pinnedText,
    previousSummary: journal.state.summary?.summary ?? '',
    critical: criticalIdentifiersOf(projected.workingFacts),
    workingState: renderedFacts(ctx, projected, workingStateCapFor(ctx.capabilities)),
  });
  const charge: RunEventPayload = {
    type: 'usage.charged',
    purpose: 'compaction',
    inputTokens: resource.usage.input_tokens,
    outputTokens: resource.usage.output_tokens,
    totalTokens: resource.usage.total_tokens,
  };
  const unreadableNotices =
    region.unreadable.length === 0
      ? []
      : [
          noticeOf(
            'compaction_outputs_unreadable',
            `Compaction fidelity check could not read ${region.unreadable.length} recorded output(s): ${region.unreadable.map((blob) => `${blob.handle} (${blob.reason})`).join('; ')}; a token found only there cannot be verified`,
          ),
        ];
  const accepted = fidelity.fabricated.length === 0;
  journal.append([
    charge,
    ...unreadableNotices,
    ...(accepted
      ? []
      : [noticeOf('compaction_rejected', `Compaction summary rejected: ${fidelity.fabricated.length} token(s) found nowhere in the replaced history or the pinned context (${fidelity.fabricated.slice(0, MAX_NAMED_TOKENS).join(', ')}); the deterministic summary was used`)]),
    accepted
      ? { type: 'context.compacted', item, summary, replacedThroughSeq: plan.throughSeq, source: 'model', fidelity, guidelineVersion }
      : deterministicCompaction(ctx, plan, guidelineVersion, fidelity),
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
    payloads.push({ type: 'notice', level: 'warning', message: notice.message, code: notice.code });
  }
  for (const instruction of built.loadedInstructions) {
    const recorded = ctx.journal.state.loadedInstructions.find((entry) => entry.path === instruction.path);
    if (recorded?.textSha256 === instruction.textSha256) continue;
    payloads.push({ type: 'instructions.loaded', path: instruction.path, content: instruction.text });
  }
  const { governingLoaded, memoriesLoaded } = ctx.journal.state;
  if (governingKeyOf(built.loadedGoverning) !== governingKeyOf(governingLoaded ?? EMPTY_GOVERNING)) {
    payloads.push({ type: 'context.governing_loaded', ...built.loadedGoverning });
  }
  const loadedMemories = built.loadedMemoryIds.map((id) => {
    const memory = ctx.recalled.memories.find((candidate) => candidate.id === id);
    if (memory === undefined) throw new Error(`the context loaded memory ${id}, which the run did not recall`);
    return { id, status: memory.status };
  });
  if (canonicalJson(loadedMemories) !== canonicalJson(memoriesLoaded ?? [])) payloads.push({ type: 'context.memories_loaded', memories: loadedMemories });
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

const governingShare = (governing: number): string => (governing === 0 ? '' : `, governing facts ${governing}`);

const namedFacts = (error: PinnedOverflowError, ids: readonly string[]): string =>
  error.breakdown.governing === 0 ? '' : ` Governing facts take ${error.breakdown.governing} of those tokens${ids.length === 0 ? '' : ` (${ids.join(', ')})`}; retire or shorten one with momonga rule.`;

export const pinnedOverflowFailure = (ctx: Pick<ClaimContext, 'capabilities'>, error: PinnedOverflowError, governingIds: readonly string[] = []): { code: 'pinned_overflow'; message: string } => {
  const { W, R } = budgetFor(ctx.capabilities, 0);
  if (error instanceof PinnedRoomError) {
    return {
      code: 'pinned_overflow',
      message: `The pinned context fits (${error.pinnedTokens} of ${error.ceiling} tokens) but leaves only ${error.room} tokens for the conversation; at least ${error.minimum} are needed for one tool call, one tool result, a summary and the working state. Reduce the fixed prefix (deny rules for unused tools, plan mode, shorter instructions) or use a larger window.${namedFacts(error, governingIds)}`,
    };
  }
  const { systemPrompt, tools, instructions, governing, task } = error.breakdown;
  const percent = error.pinnedTokens === 0 ? 0 : Math.round((100 * tools) / error.pinnedTokens);
  return {
    code: 'pinned_overflow',
    message: `The pinned context needs ${error.pinnedTokens} tokens but at most ${error.ceiling} fit (window ${W}, output reserve ${R}, estimation margin ${W - R - error.ceiling}). Breakdown: system prompt ${systemPrompt}, tool definitions ${tools} (${percent}%), instructions ${instructions}${governingShare(governing)}, task ${task}. Reduce it with deny rules for tools you do not need, \`plan\` mode, a shorter task or AGENTS.md, or a model with a larger context window.${namedFacts(error, governingIds)}`,
  };
};

export const pinnedFailureFor = (ctx: ClaimContext, error: PinnedOverflowError): { code: 'pinned_overflow'; message: string } =>
  pinnedOverflowFailure(ctx, error, governingFor(ctx, sessionOf(ctx), [], 'live').active.map((fact) => fact.id));

export const governingFailureAtStart = async (ctx: ClaimContext): Promise<{ code: 'pinned_overflow'; message: string } | undefined> => {
  if (governingFor(ctx, sessionOf(ctx), [], 'live').active.length === 0) return undefined;
  try {
    await measurePinned(contextInputOf(ctx, undefined, 0, 'live'), portsOf(ctx));
    return undefined;
  } catch (error) {
    if (error instanceof PinnedOverflowError) return pinnedFailureFor(ctx, error);
    throw error;
  }
};

type FinalAttempt = {
  successes: number;
  attempts: number;
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
      : `${error.pinnedTokens} (system prompt ${breakdown.systemPrompt}, tool definitions ${breakdown.tools}, instructions ${breakdown.instructions}${governingShare(breakdown.governing)}, task ${breakdown.task})`;
  const reason = !ctx.autoCompact
    ? AUTO_COMPACT_OFF_REASON
    : (error.compactionBlockedBy?.message ?? (attempt.triedAtLastLevel ? 'the compaction at this level did not free enough room' : 'no compaction was available'));
  return (
    `The context needs ${error.inputTokens} tokens but at most ${error.ceiling} fit (window ${W}, output reserve ${R}, estimation margin ${W - R - error.ceiling}). ` +
    `The fixed prefix takes ${prefix}. ` +
    `Earlier in this run: ${ctx.journal.state.evicted.length} tool outputs were replaced by handles and ${ctx.journal.countRecorded('context.compacted') - attempt.successes} compaction(s) were recorded. ` +
    `Final attempt: ${attempt.attempts} compaction(s) ran; no further compaction was possible because ${reason}; ` +
    `${protectionClause(error)}; ${wrapUpClause}.`
  );
};

export const buildNext = async (ctx: ClaimContext, options: { wrapUp?: WrapUpReason } = {}): Promise<BuildOutcome> => {
  const attempt: FinalAttempt = { successes: 0, attempts: 0, triedAtLastLevel: false };
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
    ctx.journal.append([{ type: 'notice', level: 'error', message: budgetStopNotice(ctx, error, attempt, clause), code: 'context_budget_stop' }]);
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
        ctx.terminals.finish('FAILED', { error: pinnedFailureFor(ctx, error) });
        return { kind: 'done' };
      }
      if (error instanceof GatewayRequestError && error.code === 'invalid_compaction') {
        if (recoverRejectedCompaction(ctx, error) === 'done') return { kind: 'done' };
        continue;
      }
      if (!(error instanceof ContextOverflowError)) throw error;
      if (error.compaction !== undefined && ctx.autoCompact && !levelsWithCompaction.has(level)) {
        levelsWithCompaction.add(level);
        if (cancelIfInterrupted(ctx) === 'done') return { kind: 'done' };
        const result = await compact(error.compaction);
        if (result === 'done') return { kind: 'done' };
        if (result === 'retry') levelsWithCompaction.delete(level);
        if (error.lastLevel) attempt.triedAtLastLevel = true;
        continue;
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
    if (built.compaction !== undefined && ctx.autoCompact && options.wrapUp === undefined && level === 0 && !proactiveDone) {
      proactiveDone = true;
      const result = await compact(built.compaction);
      if (result === 'done') return { kind: 'done' };
      if (result === 'retry') proactiveDone = false;
      continue;
    }
    recordContextFacts(ctx, built);
    recordEvictions(ctx, built.evictions);
    return { kind: 'built', built };
  }
};
