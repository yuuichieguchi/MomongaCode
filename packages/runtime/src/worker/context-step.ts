import { ContextOverflowError, PinnedOverflowError, buildContext } from '@momonga/context';
import type { BuiltContext } from '@momonga/context';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import { compactionSummaryMessage, decodeCompactionSummary } from '@momonga/protocol';
import type { RunEventPayload } from '@momonga/protocol';
import { GatewayRequestError } from '../gateway-client.ts';
import type { ClaimContext } from './claim-context.ts';
import { touchedPathsOf } from './touched-paths.ts';
import { wrapUpInstructionFor } from './wrap-up.ts';
import type { WrapUpReason } from './wrap-up.ts';

export type BuildOutcome = { kind: 'built'; built: BuiltContext } | { kind: 'done' };

const buildOnce = async (ctx: ClaimContext, wrapUp: WrapUpReason | undefined): Promise<BuiltContext> => {
  const { options, journal } = ctx;
  const state = journal.state;
  const session = sessionOf(ctx);
  const built = await buildContext(
    {
      capabilities: ctx.capabilities,
      model: ctx.alias,
      sources: {
        systemPrompt: ctx.systemPrompt,
        tools: ctx.functionTools,
        task: { type: 'message', role: 'user', content: [{ type: 'input_text', text: taskTextOf(ctx) }] },
        taskSeq: state.taskSeq,
        activatedSkills: [],
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
      ...(ctx.pinnedDigest.value === undefined ? {} : { expectedPinnedDigest: ctx.pinnedDigest.value }),
      ...(wrapUp === undefined ? {} : { tools: 'none' as const, trailing: [{ type: 'message' as const, role: 'user' as const, content: wrapUpInstructionFor(wrapUp) }] }),
    },
    {
      meter: ctx.meter,
      blobs: { put: async (text, blobOptions) => options.blobs.put(text, blobOptions) },
      instructions: options.instructionReader,
    },
  );
  if (wrapUp === undefined) ctx.pinnedDigest.value ??= built.pinnedDigest;
  return built;
};

const sessionOf = (ctx: ClaimContext) => {
  const session = ctx.options.store.getSession(ctx.run.sessionId);
  if (session === undefined) throw new Error(`unknown session ${ctx.run.sessionId}`);
  return session;
};

const taskTextOf = (ctx: ClaimContext): string => {
  const [first] = ctx.options.store.readRunEvents(ctx.run.id, 0, 1);
  if (first === undefined || first.type !== 'user.message') throw new Error(`run ${ctx.run.id} does not start with a user message`);
  return first.text;
};

export const compactThrough = async (ctx: ClaimContext, throughSeq: number): Promise<void> => {
  const { journal, options } = ctx;
  const state = journal.state;
  const input = [...(state.summary === undefined ? [] : [state.summary.item]), ...state.history.filter((entry) => entry.seq <= throughSeq).map((entry) => entry.item)];
  const idempotencyKey = sha256Hex(canonicalJson([ctx.run.id, 'compact', throughSeq]));
  ctx.control.inFlight.compactionKey = idempotencyKey;
  const resource = await ctx.control.recordingRaised(
    options.gateway.compact(
      { model: ctx.alias, input, instructions: ctx.systemPrompt },
      {
        idempotencyKey,
        deadlineAt: ctx.run.deadlineAt,
        signal: ctx.control.signal,
        traceparent: ctx.agentSpan.traceparent,
      },
    ),
  );
  delete ctx.control.inFlight.compactionKey;
  const compaction = resource.output.find((item) => item.type === 'compaction');
  if (compaction === undefined) throw new Error(`the compaction response for run ${ctx.run.id} holds no compaction item`);
  journal.append([
    {
      type: 'context.compacted',
      item: { type: 'compaction', id: compaction.id, encrypted_content: compaction.encrypted_content },
      summary: decodeCompactionSummary(compaction.encrypted_content) ?? '',
      replacedThroughSeq: throughSeq,
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
};

const recordEvictions = (ctx: ClaimContext, built: BuiltContext): void => {
  const state = ctx.journal.state;
  const unreflected = built.evictions.filter((eviction) => {
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

export const buildNext = async (ctx: ClaimContext, options: { wrapUp?: WrapUpReason } = {}): Promise<BuildOutcome> => {
  let forcedCompaction = false;
  let compacted = false;
  let compacting: 'forced' | 'threshold' | undefined;
  const compactOnce = async (throughSeq: number, kind: 'forced' | 'threshold'): Promise<void> => {
    compacting = kind;
    await compactThrough(ctx, throughSeq);
    compacting = undefined;
  };
  const attemptBuild = async (): Promise<BuildOutcome | undefined> => {
    if (cancelIfInterrupted(ctx) === 'done') return { kind: 'done' };
    let built: BuiltContext;
    try {
      built = await buildOnce(ctx, options.wrapUp);
    } catch (error) {
      if (error instanceof PinnedOverflowError) {
        ctx.terminals.finish('FAILED', {
          error: {
            code: 'pinned_overflow',
            message: `The pinned context (system prompt, project instructions and task) needs ${error.pinnedTokens} tokens but the input budget is ${error.inputBudget}. Shorten the task or the AGENTS.md files, or use a model with a larger context window.`,
          },
        });
        return { kind: 'done' };
      }
      if (error instanceof ContextOverflowError) {
        if (forcedCompaction || error.compactThroughSeq === undefined) {
          ctx.journal.append([
            { type: 'notice', level: 'error', message: `The context still exceeds the input budget (${error.inputTokens} of ${error.inputBudget} tokens) after compaction, so the run stops.` },
          ]);
          ctx.terminals.finish('STOPPED', { stopReason: 'budget' });
          return { kind: 'done' };
        }
        forcedCompaction = true;
        if (cancelIfInterrupted(ctx) === 'done') return { kind: 'done' };
        await compactOnce(error.compactThroughSeq, 'forced');
        return undefined;
      }
      throw error;
    }
    if (cancelIfInterrupted(ctx) === 'done') return { kind: 'done' };
    if (built.needsCompaction && built.compactThroughSeq !== undefined && !compacted) {
      compacted = true;
      await compactOnce(built.compactThroughSeq, 'threshold');
      return undefined;
    }
    recordContextFacts(ctx, built);
    recordEvictions(ctx, built);
    return { kind: 'built', built };
  };
  for (;;) {
    try {
      const outcome = await attemptBuild();
      if (outcome !== undefined) return outcome;
    } catch (error) {
      if (recoverRejectedCompaction(ctx, error) === 'done') return { kind: 'done' };
      if (compacting === 'forced') forcedCompaction = false;
      if (compacting === 'threshold') compacted = false;
      if (compacting !== undefined) delete ctx.control.inFlight.compactionKey;
      compacting = undefined;
    }
  }
};
