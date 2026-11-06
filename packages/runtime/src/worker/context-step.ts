import {
  ContextOverflowError,
  PinnedBoundError,
  PinnedOverflowError,
  PinnedRoomError,
  PrefixChangedError,
  budgetFor,
  buildContext,
  checkSummary,
  claimedTokens,
  criticalIdentifiersOf,
  measureLayers,
  measurePinned,
  readerNamesOf,
  readersOffered,
  referenceKindsOf,
  renderWorkingState,
  withCalibration,
  workingStateCapFor,
} from '@momonga/context';
import type { ActivatedSkill, ReferenceReaders, TokenMeter, BuildContextInput, ContextArrival, ContextNotice, BuildContextPorts, BuiltContext, CompactionPlan, ContextEviction, LoadedGoverning, PinnedMeasure } from '@momonga/context';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import { resolveGoverning } from '@momonga/memory';
import type { Session } from '@momonga/store';
import { DETERMINISTIC_SUMMARY_TEXT, compactionSummaryMessage, decodeCompactionSummary, tokensForText, userMessageContent } from '@momonga/protocol';
import type { CompactRequest, CompactResource, CompactionInputItem, ContentPart, FunctionTool, InputItem, MessageInputItem, NoticeReduction, RunEvent, RunEventPayload, RunState, SummaryFidelity } from '@momonga/protocol';
import { foldRunState } from '@momonga/store';
import { GatewayRequestError } from '../gateway-client.ts';
import { recallQueryOf } from '../memory/recall-query.ts';
import { MEMORY_QUERY_MAX_CHARS } from '@momonga/tools';
import { arrivalsOf } from './context-arrivals.ts';
import { renderedFormsOf } from './context-forms.ts';
import type { ClaimContext } from './claim-context.ts';
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

export const taskOf = (ctx: ClaimContext): { content: ContentPart[]; text: string } => {
  const [first] = ctx.options.store.readRunEvents(ctx.run.id, 0, 1);
  if (first === undefined || first.type !== 'user.message') throw new Error(`run ${ctx.run.id} does not start with a user message`);
  return { content: userMessageContent(first.text, first.images), text: first.text };
};

type GoverningScan = 'active' | 'live';

const governingFor = (ctx: ClaimContext, session: Session, scan: GoverningScan) =>
  resolveGoverning(ctx.options.store.governing.list({ project: session.cwd }), {
    now: ctx.options.clock.now(),
    project: session.cwd,
    touchedPaths: [...ctx.touched.governing.witnesses(), ctx.options.tools.sessionState(session).cwd],
    ...(scan === 'live' ? { ignorePaths: true } : {}),
  });

const advanceTouched = async (ctx: ClaimContext): Promise<void> => {
  const session = sessionOf(ctx);
  await ctx.touched.governing.advance(ctx.options.store.governing.list({ project: session.cwd }), ctx.options.clock.now());
  await ctx.touched.probes.advance();
};

const prepareRecall = async (ctx: ClaimContext): Promise<void> => {
  const session = sessionOf(ctx);
  const task = taskOf(ctx);
  const newest = ctx.options.store.sessionTouched.newest(session.id, MEMORY_QUERY_MAX_CHARS).map((entry) => entry.path);
  await ctx.recalled.prepare({
    query: recallQueryOf(task.text, newest, session.cwd),
    capacity: { capabilities: withCalibration(ctx.capabilities, ctx.calibration), memoryShare: ctx.memoryShare },
    ...(ctx.token.cachePrefix && ctx.journal.state.memoriesLoaded !== undefined ? { pinnedIds: ctx.journal.state.memoriesLoaded.map((memory) => memory.id) } : {}),
  });
};

const governingKeyOf = (governing: { active: unknown; conflicts: unknown }): string => canonicalJson({ active: governing.active, conflicts: governing.conflicts });

const EMPTY_GOVERNING: LoadedGoverning = { active: [], conflicts: [] };

const renderedWorkingState = (ctx: ClaimContext, state: RunState, capTokens: number, readers: ReferenceReaders): string => {
  const text = renderWorkingState(state, { capTokens, tokensOf: tokensForText, verificationCommands: ctx.verificationCommands, readers });
  if (text === undefined) throw new Error(`run ${state.runId} has no summary to render a working state for`);
  return text;
};

const workingStateOf = (ctx: ClaimContext, state: RunState): ((readers: ReferenceReaders) => string) | undefined =>
  state.summary === undefined ? undefined : (readers) => renderedWorkingState(ctx, state, workingStateCapFor(ctx.capabilities), readers);

const projectedWorkingStateOf = (ctx: ClaimContext, state: RunState): string | undefined =>
  state.history.length === 0
    ? undefined
    : renderedWorkingState(ctx, projectCompaction(ctx, state.nextItemSeq - 1, compactionSummaryMessage('', 'model'), ''), workingStateCapFor(ctx.capabilities), ctx.readers());

type AdmittedFloor = { pinnedTokens: number; tools: FunctionTool[]; offered: string; governing: string; kinds: string };

const kindsKeyOf = (state: RunState): string => [...referenceKindsOf(state)].sort().join('\n');

type Companions = ReturnType<ClaimContext['companions']>;

const offeredKeyOf = (tools: readonly FunctionTool[], companions: Companions): string => sha256Hex(canonicalJson({ tools, companions }));

const admittedFloors = new WeakMap<ClaimContext, AdmittedFloor>();

const recordedReferencesOf = (ctx: ClaimContext): ReadonlySet<string> =>
  ctx.token.outputFormatters.includes('identicalOutput')
    ? new Set(
        ctx.options.store
          .readRunEventsOfTypes(ctx.run.id, ['context.truncated'])
          .flatMap((event) => (event.type === 'context.truncated' && event.kind === 'reference' ? [event.callId] : [])),
      )
    : new Set<string>();

type OfferedInput = { input: BuildContextInput; offered: string; governing: string; kinds: string; joined: string[] };

const offeredInputOf = (
  ctx: ClaimContext,
  wrapUp: WrapUpReason | undefined,
  level: number,
  scan: GoverningScan,
  trailing: readonly InputItem[],
): OfferedInput => {
  const { options, journal } = ctx;
  const state = journal.state;
  const session = sessionOf(ctx);
  const workingState = workingStateOf(ctx, state);
  const projectedWorkingState = projectedWorkingStateOf(ctx, state);
  const task = taskOf(ctx);
  const matchCap = ctx.recalled.matchCap();
  const candidates = ctx.functionTools();
  const companions = ctx.companions();
  const offered = offeredKeyOf(candidates, companions);
  const governing = governingFor(ctx, session, scan);
  const governingKey = governingKeyOf(governing);
  const kinds = kindsKeyOf(state);
  const readers = readersOffered(ctx.readers(), candidates);
  const recorded = admittedFloors.get(ctx);
  const admittedTools = recorded !== undefined && (ctx.token.observedCapacity ? true : recorded.offered === offered && recorded.kinds === kinds) ? recorded : undefined;
  const readerNames = new Set(readerNamesOf(readers, state));
  const joined =
    admittedTools !== undefined && admittedTools.kinds !== kinds
      ? candidates.filter((tool) => readerNames.has(tool.name) && !admittedTools.tools.some((admitted) => admitted.name === tool.name))
      : [];
  const admittedFloor = admittedTools !== undefined && admittedTools.governing === governingKey && joined.length === 0 ? admittedTools : undefined;
  const rendered = ctx.token.observedCapacity ? renderedFormsOf(options.store, state) : undefined;
  const wrapUpItems: InputItem[] = wrapUp === undefined ? [] : [{ type: 'message', role: 'user', content: wrapUpInstructionFor(wrapUp) }];
  const input: BuildContextInput = {
    capabilities: ctx.capabilities,
    calibration: ctx.calibration,
    model: ctx.alias,
    sources: {
      systemPrompt: ctx.systemPrompt,
      tools: admittedTools === undefined ? candidates : [...admittedTools.tools, ...joined],
      readers,
      task: { type: 'message', role: 'user', content: task.content },
      taskSeq: state.taskSeq,
      ...(ctx.skills.catalog === undefined ? {} : { skillCatalog: ctx.skills.catalog }),
      activatedSkills: state.activatedSkills,
      governing,
      memories: ctx.recalled.ranked(),
      ...(ctx.recalled.hasMore() ? { moreMemories: true } : {}),
      ...(matchCap === undefined ? {} : { memoryMatchCap: matchCap }),
      history: state.history
        .filter((entry) => entry.seq !== state.taskSeq)
        .map((entry) => ({ seq: entry.seq, item: entry.item, ...(entry.handle === undefined ? {} : { handle: entry.handle }) })),
      ...(state.summary === undefined ? {} : { summary: { item: state.summary.item, replacedThroughSeq: state.summary.replacedThroughSeq } }),
      ...(workingState === undefined ? {} : { workingState }),
      ...(projectedWorkingState === undefined ? {} : { projectedWorkingState }),
    },
    companions,
    evicted: new Set(state.evicted),
    recordedReferences: recordedReferencesOf(ctx),
    ...(ctx.memoryShare === undefined ? {} : { memoryShare: ctx.memoryShare }),
    touchedPaths: ctx.touched.probes.witnesses(),
    trusted: options.settings.trusted(session),
    projectRoot: session.cwd,
    home: options.home,
    level,
    ...(ctx.pinnedDigest.value === undefined ? {} : { expectedPinnedDigest: ctx.pinnedDigest.value }),
    ...(wrapUp === undefined ? {} : { tools: 'none' as const }),
    ...(wrapUpItems.length + trailing.length === 0 ? {} : { trailing: [...trailing, ...wrapUpItems] }),
    ...(ctx.token.cachePrefix
      ? {
          layout: 'cachePrefix' as const,
          arrivals: arrivalsOf(state),
          ...(state.memoriesLoaded === undefined ? {} : { pinnedMemoryIds: state.memoriesLoaded.map((memory) => memory.id) }),
        }
      : {}),
    ...(admittedTools === undefined ? {} : { toolsFrozen: true as const }),
    ...(admittedFloor === undefined ? {} : { pinnedTokens: admittedFloor.pinnedTokens }),
    ...(ctx.token.observedCapacity
      ? {
          observedCapacity: true as const,
          ...(rendered === undefined ? {} : { forms: rendered.forms, renderedFull: rendered.renderedFull }),
        }
      : {}),
    outputFormatters: ctx.token.outputFormatters,
  };
  return { input, offered, governing: governingKey, kinds, joined: joined.map((tool) => tool.name) };
};

export const contextInputOf = (
  ctx: ClaimContext,
  wrapUp: WrapUpReason | undefined,
  level: number,
  scan: GoverningScan = 'active',
  trailing: readonly InputItem[] = [],
): BuildContextInput => offeredInputOf(ctx, wrapUp, level, scan, trailing).input;

const portsOf = (ctx: ClaimContext): BuildContextPorts => ({
  meter: ctx.meter,
  fallbackMeters: ctx.fallbackMeters,
  blobs: {
    handleFor: (content) => ctx.options.blobs.handleFor(content),
    put: async (text, blobOptions) => ctx.options.blobs.put(text, { ...blobOptions, runId: ctx.run.id }),
  },
  instructions: ctx.options.instructionReader,
});

export const measurePinnedFor = async (ctx: ClaimContext): Promise<PinnedMeasure> => {
  await advanceTouched(ctx);
  return measurePinned(contextInputOf(ctx, undefined, 0), portsOf(ctx));
};

export type ToolsMeasure = { measure: PinnedMeasure; floorTokens: number; kept: readonly string[] };

export const measureToolsWith = async (ctx: ClaimContext, tools: readonly FunctionTool[]): Promise<ToolsMeasure> => {
  await advanceTouched(ctx);
  const input: BuildContextInput = { ...contextInputOf(ctx, undefined, 0) };
  delete input.pinnedTokens;
  delete input.toolsFrozen;
  const counts: { tools: readonly FunctionTool[]; tokens: number }[] = [];
  const ports = portsOf(ctx);
  const meter: TokenMeter = {
    ...ports.meter,
    count: async (request) => {
      const counted = await ports.meter.count(request);
      counts.push({ tools: request.tools, tokens: counted.inputTokens });
      return counted;
    },
  };
  const measure = await measurePinned({ ...input, sources: { ...input.sources, tools: [...tools] } }, { ...ports, meter });
  const first = counts[0];
  const last = counts[counts.length - 1];
  if (first === undefined || last === undefined) throw new Error('measuring the pinned floor counted nothing');
  return { measure, floorTokens: first.tokens, kept: last.tools.map((tool) => tool.name) };
};

export const hasAdmittedTools = (ctx: ClaimContext): boolean => ctx.token.observedCapacity && admittedFloors.has(ctx);

export const rememberAdmittedTools = (ctx: ClaimContext, tools: readonly FunctionTool[], pinnedTokens: number): void => {
  const admitted = admittedFloors.get(ctx);
  if (ctx.token.observedCapacity && admitted !== undefined) admittedFloors.set(ctx, { ...admitted, pinnedTokens, tools: [...tools] });
};

const withNewSkills = (arrivals: readonly ContextArrival[], activatedSkills: readonly ActivatedSkill[]): ContextArrival[] => [
  ...arrivals,
  ...activatedSkills
    .filter((skill) => !arrivals.some((arrival) => arrival.kind === 'skill' && arrival.name === skill.name))
    .map((skill): ContextArrival => ({ kind: 'skill', name: skill.name, content: skill.content })),
];

export const measureLayersWith = async (ctx: ClaimContext, activatedSkills: readonly ActivatedSkill[]): Promise<void> => {
  await advanceTouched(ctx);
  const input = contextInputOf(ctx, undefined, 0);
  delete input.pinnedTokens;
  await measureLayers(
    {
      ...input,
      sources: { ...input.sources, activatedSkills },
      ...(input.arrivals === undefined ? {} : { arrivals: withNewSkills(input.arrivals, activatedSkills) }),
    },
    portsOf(ctx),
  );
};

const buildOnce = async (ctx: ClaimContext, wrapUp: WrapUpReason | undefined, level: number, trailing: readonly InputItem[]): Promise<BuiltContext> => {
  await advanceTouched(ctx);
  await prepareRecall(ctx);
  const { input, offered, governing, kinds, joined } = offeredInputOf(ctx, wrapUp, level, 'active', trailing);
  const built = await buildContext(input, portsOf(ctx));
  if (wrapUp === undefined) {
    ctx.pinnedDigest.value ??= built.pinnedDigest;
    if (input.pinnedTokens === undefined) {
      admittedFloors.set(ctx, { pinnedTokens: built.pinnedTokens, tools: built.tools, offered, governing, kinds });
    }
    if (joined.length > 0) ctx.journal.append([{ type: 'tool.loaded', names: joined }]);
  }
  return built;
};

type CompactedPayload = Extract<RunEventPayload, { type: 'context.compacted' }>;
type CompactedEvent = Extract<RunEvent, { type: 'context.compacted' }>;
type CompactionSource = Pick<CompactionPlan, 'throughSeq' | 'input' | 'summaryTokenCap' | 'pinnedText' | 'notices'>;

const noticeOf = (code: string, message: string): RunEventPayload => ({ type: 'notice', level: 'warning', message, code });

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

const renderedFacts = (ctx: ClaimContext, projected: RunState, capTokens: number): string => renderedWorkingState(ctx, projected, capTokens, ctx.readers());

const deterministicCompaction = (plan: CompactionSource, guidelineVersion: number, fidelity?: SummaryFidelity): CompactedPayload => ({
  type: 'context.compacted',
  item: compactionSummaryMessage(DETERMINISTIC_SUMMARY_TEXT, 'code'),
  summary: DETERMINISTIC_SUMMARY_TEXT,
  replacedThroughSeq: plan.throughSeq,
  source: 'deterministic',
  ...(fidelity === undefined ? {} : { fidelity }),
  guidelineVersion,
});

export const compactThrough = async (ctx: ClaimContext, plan: CompactionSource): Promise<void> => {
  const { journal, options } = ctx;
  const roleAlias = ctx.roles.compaction;
  const request: CompactRequest = {
    model: roleAlias ?? ctx.alias,
    input: plan.input,
    momonga: { max_summary_tokens: plan.summaryTokenCap, retains_user_request: true, ...(ctx.guideline === undefined ? {} : { guideline: ctx.guideline.text }) },
  };
  const guidelineVersion = ctx.guideline?.version ?? NO_ADOPTED_GUIDELINE;
  const idempotencyKey = sha256Hex(canonicalJson([ctx.run.id, 'compact', sha256Hex(canonicalJson(request))]));
  ctx.control.inFlight.compactionKey = idempotencyKey;
  let resource: CompactResource;
  const startedAt = options.clock.now();
  try {
    resource = await ctx.control.recordingRaised(
      options.gateway.compact(request, {
        idempotencyKey,
        deadlineAt: ctx.run.deadlineAt,
        signal: ctx.control.signal,
        traceparent: ctx.agentSpan.traceparent,
        runId: ctx.run.id,
      }),
    );
  } catch (error) {
    if (!escalates(error)) throw error;
    delete ctx.control.inFlight.compactionKey;
    journal.append([
      noticeOf(
        'compaction_failed',
        `Compaction summary failed (${error.code}): ${error.message}${roleAlias === undefined ? '' : ` [models.roles.compaction names alias ${roleAlias}]`}; the deterministic summary was used`,
      ),
      deterministicCompaction(plan, NO_ADOPTED_GUIDELINE),
      ...unrecordedNoticePayloads(ctx, plan.notices),
    ]);
    return;
  }
  delete ctx.control.inFlight.compactionKey;
  const compaction = resource.output.find((item) => item.type === 'compaction');
  if (compaction === undefined) throw new Error(`the compaction response for run ${ctx.run.id} holds no compaction item`);
  const item: CompactionInputItem = { type: 'compaction', id: compaction.id, encrypted_content: compaction.encrypted_content };
  const summary = decodeCompactionSummary(compaction.encrypted_content) ?? '';
  const projected = projectCompaction(ctx, plan.throughSeq, item, summary);
  const claims = claimedTokens(summary);
  const recorded = await options.store.journalFacts.fidelity(
    {
      runId: ctx.run.id,
      throughEventSeq: projected.workingFacts.replacedThroughEventSeq ?? journal.state.lastSeq,
      cwd: sessionOf(ctx).cwd,
      tokens: claims,
    },
    ctx.control.signal,
  );
  const fidelity = checkSummary(summary, {
    attested: recorded.attested,
    pinned: plan.pinnedText,
    critical: criticalIdentifiersOf(projected.workingFacts),
    workingState: renderedFacts(ctx, projected, workingStateCapFor(ctx.capabilities)),
  });
  const charge: RunEventPayload = {
    type: 'usage.charged',
    purpose: 'compaction',
    inputTokens: resource.usage.input_tokens,
    outputTokens: resource.usage.output_tokens,
    totalTokens: resource.usage.total_tokens,
    responseId: resource.id,
    cachedInputTokens: resource.usage.input_tokens_details.cached_tokens,
    ...(resource.momonga?.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: resource.momonga.cacheWriteInputTokens }),
    ...(resource.momonga?.cost === undefined ? {} : { cost: resource.momonga.cost }),
    timing: { durationMs: options.clock.now() - startedAt },
  };
  const unreadableNotices =
    recorded.unreadable.length === 0
      ? []
      : [
          noticeOf(
            'compaction_outputs_unreadable',
            `Compaction fidelity check could not read ${recorded.unreadable.length} recorded output(s): ${recorded.unreadable.map((blob) => `${blob.handle} (${blob.reason})`).join('; ')}; a token found only there cannot be verified`,
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
      : deterministicCompaction(plan, guidelineVersion, fidelity),
    ...unrecordedNoticePayloads(ctx, plan.notices),
  ]);
};

const interrupted = (ctx: ClaimContext): boolean => ctx.control.signal.aborted || ctx.control.cancelRequested();

export const cancelIfInterrupted = async (ctx: ClaimContext): Promise<'done' | undefined> => {
  const failure = ctx.control.failure();
  if (failure !== undefined) throw failure;
  if (ctx.control.leaseLost()) ctx.control.lost();
  if (ctx.control.shuttingDown()) return ctx.terminals.yieldLease();
  return interrupted(ctx) ? ctx.terminals.cancel() : undefined;
};

const unrecordedNoticePayloads = (ctx: ClaimContext, notices: readonly ContextNotice[]): RunEventPayload[] => {
  const identityOf = (message: string, code: string | undefined, reduction: NoticeReduction | undefined): string =>
    reduction === undefined ? canonicalJson(['message', message]) : canonicalJson(['reduction', code, reduction.turn, reduction.from, reduction.to]);
  const known = new Set(ctx.journal.state.notes.map((note) => identityOf(note.message, note.code, note.reduction)));
  const payloads: RunEventPayload[] = [];
  for (const notice of notices) {
    const identity = identityOf(notice.message, notice.code, notice.reduction);
    if (known.has(identity)) continue;
    known.add(identity);
    payloads.push({
      type: 'notice',
      level: 'warning',
      message: notice.message,
      code: notice.code,
      ...(notice.reduction === undefined ? {} : { reduction: notice.reduction }),
    });
  }
  return payloads;
};

const recordContextFacts = (ctx: ClaimContext, built: BuiltContext): void => {
  const payloads = unrecordedNoticePayloads(ctx, built.notices);
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
    const memory = ctx.recalled.ranked().find((candidate) => candidate.id === id);
    if (memory === undefined) throw new Error(`the context loaded memory ${id}, which the run did not recall`);
    return { id, status: memory.status };
  });
  const firstRanking = ctx.token.cachePrefix && memoriesLoaded === undefined;
  if (firstRanking || canonicalJson(loadedMemories) !== canonicalJson(memoriesLoaded ?? [])) payloads.push({ type: 'context.memories_loaded', memories: loadedMemories });
  if (payloads.length > 0) ctx.journal.append(payloads);
};

const recordEvictions = (ctx: ClaimContext, evictions: readonly ContextEviction[]): void => {
  const state = ctx.journal.state;
  const recordedForms = ctx.token.observedCapacity ? new Map(Object.entries(state.formsSinceCompaction)) : undefined;
  const unreflected = evictions.filter((eviction) => {
    const entry = state.history.find((candidate) => candidate.callId === eviction.callId && candidate.item.type === 'function_call_output');
    if (entry === undefined) return false;
    if (eviction.kind === 'omitted') return !state.evicted.includes(eviction.callId);
    if (eviction.kind === 'reference') return true;
    return entry.handle === undefined || (recordedForms !== undefined && recordedForms.get(eviction.callId) !== eviction.keptChars);
  });
  if (unreflected.length === 0) return;
  ctx.journal.append(
    unreflected.map((eviction) => ({
      type: 'context.truncated',
      callId: eviction.callId,
      handle: eviction.handle,
      kind: eviction.kind,
      ...(eviction.keptChars === undefined ? {} : { keptChars: eviction.keptChars }),
    })),
  );
};

export const recoverRejectedCompaction = async (ctx: ClaimContext, error: unknown, position?: { step: number; attempt: number }): Promise<'recovered' | 'done'> => {
  const summary = ctx.journal.state.summary;
  if (!(error instanceof GatewayRequestError) || error.code !== 'invalid_compaction' || summary?.item.type !== 'compaction') throw error;
  if (summary.summary === '') {
    await ctx.terminals.finish('FAILED', {
      error: {
        code: 'compaction_unverifiable',
        message: 'The gateway rejected the compaction item of this run and its summary text was not recorded, so the conversation cannot be rebuilt.',
      },
    });
    return 'done';
  }
  ctx.journal.append([{ type: 'context.compaction_rejected', ...(position ?? {}), item: compactionSummaryMessage(summary.summary, 'model') }]);
  return 'recovered';
};

const governingShare = (governing: number): string => (governing === 0 ? '' : `, governing facts ${governing}`);

const namedFacts = (error: PinnedOverflowError, ids: readonly string[]): string =>
  error.breakdown.governing === 0 ? '' : ` Governing facts take ${error.breakdown.governing} of those tokens${ids.length === 0 ? '' : ` (${ids.join(', ')})`}; retire or shorten one with momonga rule.`;

export const pinnedOverflowFailure = (ctx: Pick<ClaimContext, 'capabilities'>, error: PinnedOverflowError, governingIds: readonly string[] = []): { code: 'pinned_overflow'; message: string } => {
  const { W, R } = budgetFor(ctx.capabilities, 0);
  if (error instanceof PinnedBoundError) {
    const limits = `the input budget of ${error.inputBudget} (window ${W}, output reserve ${R})`;
    const remedy = 'Raise contextWindow, lower maxOutputTokens, or calibrate the token counter.';
    return {
      code: 'pinned_overflow',
      message:
        error.maxInput === undefined
          ? `No input size fits: the token counter's error bound is ${error.boundAtZero} tokens even for an empty input, more than ${limits}. ${remedy}`
          : `The pinned context needs ${error.pinnedTokens} tokens, but with the token counter's error bound at most ${error.maxInput} fit ${limits}, so no compaction can make room. ${remedy}`,
    };
  }
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
  pinnedOverflowFailure(ctx, error, governingFor(ctx, sessionOf(ctx), 'live').active.map((fact) => fact.id));

export const governingFailureAtStart = async (ctx: ClaimContext): Promise<{ code: 'pinned_overflow'; message: string } | undefined> => {
  if (governingFor(ctx, sessionOf(ctx), 'live').active.length === 0) return undefined;
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
    `Earlier in this run: ${ctx.journal.state.evicted.length} tool outputs were replaced by handles and ${ctx.journal.state.compactions - attempt.successes} compaction(s) were recorded. ` +
    `Final attempt: ${attempt.attempts} compaction(s) ran; no further compaction was possible because ${reason}; ` +
    `${protectionClause(error)}; ${wrapUpClause}.`
  );
};

export const buildNext = async (ctx: ClaimContext, options: { wrapUp?: WrapUpReason; trailing?: readonly InputItem[] } = {}): Promise<BuildOutcome> => {
  try {
    return await buildNextUnguarded(ctx, options);
  } catch (error) {
    if (!(error instanceof PrefixChangedError)) throw error;
    ctx.terminals.yieldTo('QUEUED', ctx.options.clock.now(), { refundAttempt: true });
    return { kind: 'done' };
  }
};

const buildNextUnguarded = async (ctx: ClaimContext, options: { wrapUp?: WrapUpReason; trailing?: readonly InputItem[] }): Promise<BuildOutcome> => {
  const trailing = options.trailing ?? [];
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
        return (await recoverRejectedCompaction(ctx, error)) === 'done' ? 'done' : 'retry';
      }
      throw error;
    }
  };

  const stop = async (error: ContextOverflowError, clause: string): Promise<BuildOutcome> => {
    ctx.journal.append([{ type: 'notice', level: 'error', message: budgetStopNotice(ctx, error, attempt, clause), code: 'context_budget_stop' }]);
    await ctx.terminals.finish('STOPPED', { stopReason: 'budget' });
    return { kind: 'done' };
  };

  for (;;) {
    if ((await cancelIfInterrupted(ctx)) === 'done') return { kind: 'done' };
    let built: BuiltContext;
    try {
      built = await buildOnce(ctx, options.wrapUp, level, trailing);
    } catch (error) {
      if (error instanceof PinnedOverflowError) {
        await ctx.terminals.finish('FAILED', { error: pinnedFailureFor(ctx, error) });
        return { kind: 'done' };
      }
      if (error instanceof GatewayRequestError && error.code === 'invalid_compaction') {
        if ((await recoverRejectedCompaction(ctx, error)) === 'done') return { kind: 'done' };
        continue;
      }
      if (!(error instanceof ContextOverflowError)) throw error;
      ctx.options.onContextOverflow?.(error);
      if (error.compaction !== undefined && ctx.autoCompact && !levelsWithCompaction.has(level)) {
        levelsWithCompaction.add(level);
        if ((await cancelIfInterrupted(ctx)) === 'done') return { kind: 'done' };
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
        wrapUpBuilt = await buildOnce(ctx, 'context', error.level, trailing);
      } catch (wrapUpError) {
        if (wrapUpError instanceof ContextOverflowError || wrapUpError instanceof PinnedOverflowError) {
          return stop(error, 'the context does not fit even without tools, so no final summary was requested');
        }
        throw wrapUpError;
      }
      if ((await cancelIfInterrupted(ctx)) === 'done') return { kind: 'done' };
      recordContextFacts(ctx, wrapUpBuilt);
      recordEvictions(ctx, wrapUpBuilt.evictions);
      return { kind: 'built', built: wrapUpBuilt, wrapUp: { reason: 'context', notice: budgetStopNotice(ctx, error, attempt, 'a final summary was requested') } };
    }
    if ((await cancelIfInterrupted(ctx)) === 'done') return { kind: 'done' };
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
