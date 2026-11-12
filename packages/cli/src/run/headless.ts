import { EXIT_FAILURE, EXIT_INTERRUPTED, EXIT_OK, EXIT_WAITING_FOR_APPROVAL, isRecord } from '@momonga/foundation';
import type { MomongaPaths, SandboxNetworkSetting } from '@momonga/foundation';
import { TARGET_NOT_READY, WORDS, agentReadiness, approvalShownLines, attachRunCommand, heldEndOf, isOpaqueEvent, readinessShownText, unknownEffectLines, unknownEffectTitle, usdOfNano } from '@momonga/protocol';
import type { BudgetExhausted, Mandate, MomongaModelEntry, PermissionMode, PlanAccountRef, PublicRunEvent, QuiescentBehaviour, RunReport, Surface, UnknownEffectCall } from '@momonga/protocol';
import { RunApiError } from '../client/runtime-client.ts';
import type { RunEventFrame, RuntimeClient } from '../client/runtime-client.ts';
import type { RunView } from '../client/views.ts';
import { daemonReadyBoundMs, restoreDaemon } from '../daemon/ensure-daemon.ts';
import type { NewerListener } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import { shellModelsOf } from '../plain-http.ts';
import { escapedLines } from '../terminal-writer.ts';
import { describeElicitation } from '../elicit/describe.ts';
import { readImageAttachment } from '../images.ts';
import { mcpAuthorizationNotice } from '../mcp/messages.ts';
import { describeRetryWait } from '../retry-wait.ts';
import type { AttemptFailed } from '../retry-wait.ts';
import { describeClassification, describeDenial, describeHook, describeRunError, describeVerification, unmetConditionLines } from '../policy-messages.ts';
import { asChildEvent, noEventTypeLeft } from './child-events.ts';
import { followRun } from './follow.ts';
import { adoptionOf, refuseStart } from '../handover/start.ts';
import { newerListenerOf, streamMoveOf, streamSurface } from '../handover/stream.ts';
import type { StreamMove } from '../handover/stream.ts';
import type { StreamRecord } from '../handover/record.ts';
import { ensureSessionDaemon } from '../daemon/ensure-daemon.ts';
import { NoModelConnected, connectSessionRuntime, openSession } from './open-session.ts';
import type { CliSession, ListedModels } from './open-session.ts';
import type { HeadlessReopen } from './resolve-session.ts';
import { resolveSkillInvocation } from './skill-invocation.ts';

import { OUTPUT_FORMATS } from './output-format.ts';
import type { OutputFormat } from './output-format.ts';

export { OUTPUT_FORMATS };
export type { OutputFormat };

export type HeadlessOptions = {
  prompt: string;
  format: OutputFormat;
  permissionMode?: PermissionMode;
  bypassAllowed?: boolean;
  sandboxNetwork?: SandboxNetworkSetting;
  model?: string;
  reopen?: HeadlessReopen;
  capabilitiesOf(model: string): Promise<MomongaModelEntry['capabilities']>;
  modelList(): Promise<ListedModels>;
  skill?: string;
  images?: readonly string[];
  mandate?: Mandate;
  issue?: string;
  limits?: { maxCostUsd?: number };
  verbose: boolean;
  interrupt: AbortSignal;
};

export type RunResult = {
  type: 'result';
  subtype: 'success' | 'error';
  is_error: boolean;
  result: string;
  session_id: string;
  run_id: string;
  status: RunView['status'];
  stop_reason?: string;
  error?: { code: string; message: string; plan?: PlanAccountRef };
  num_turns: number;
  usage: RunView['usage'];
  cost_usd?: string;
  unpriced_calls?: number;
  budget?: ResultBudget;
  report?: RunReport;
};

type ResultStop = { dimension: BudgetExhausted['dimension']; cause: BudgetExhausted['cause'] } & ({ spent: number; limit: number } | { spent_usd: string; limit_usd: string });

export type ResultBudget = {
  limits: { max_steps?: number; max_total_tokens?: number; max_cost_usd?: string; deadline_at: number };
  spent: { steps: number; total_tokens: number; cost_usd: string; unpriced_calls: number };
  reserved: { tokens: number; cost_usd: string };
  stopped_by?: ResultStop;
};

const resultStopOf = (stopped: BudgetExhausted): ResultStop =>
  stopped.dimension === 'cost'
    ? { dimension: stopped.dimension, cause: stopped.cause, spent_usd: usdOfNano(stopped.spent), limit_usd: usdOfNano(stopped.limit) }
    : { dimension: stopped.dimension, cause: stopped.cause, spent: stopped.spent, limit: stopped.limit };

const resultBudgetOf = (report: RunReport | undefined): { budget?: ResultBudget } => {
  if (report?.budget === undefined) return {};
  const { limits, spent, reserved } = report.budget;
  return {
    budget: {
      limits: {
        ...(limits.maxSteps === undefined ? {} : { max_steps: limits.maxSteps }),
        ...(limits.maxTotalTokens === undefined ? {} : { max_total_tokens: limits.maxTotalTokens }),
        ...(limits.maxCostNano === undefined ? {} : { max_cost_usd: usdOfNano(limits.maxCostNano) }),
        deadline_at: limits.deadlineAt,
      },
      spent: { steps: spent.steps, total_tokens: spent.totalTokens, cost_usd: usdOfNano(spent.costNano), unpriced_calls: spent.unpricedCalls },
      reserved: { tokens: reserved.tokens, cost_usd: usdOfNano(reserved.costNano) },
      ...(report.stoppedBy === undefined ? {} : { stopped_by: resultStopOf(report.stoppedBy) }),
    },
  };
};

export const resultOf = (run: RunView, result: string): RunResult => ({
  type: 'result',
  subtype: run.status === 'COMPLETED' ? 'success' : 'error',
  is_error: run.status !== 'COMPLETED',
  result,
  session_id: run.sessionId,
  run_id: run.id,
  status: run.status,
  ...(run.stopReason === undefined ? {} : { stop_reason: run.stopReason }),
  ...(run.error === undefined ? {} : { error: run.error }),
  num_turns: run.step,
  usage: run.usage,
  ...(run.usage.costNano === undefined ? {} : { cost_usd: usdOfNano(run.usage.costNano) }),
  ...(run.usage.unpricedCalls === undefined ? {} : { unpriced_calls: run.usage.unpricedCalls }),
  ...resultBudgetOf(run.report),
  ...(run.report === undefined ? {} : { report: run.report }),
});

const endReasonLines = (run: RunView, surface: Surface): string[] => {
  if (run.error !== undefined) return describeRunError(run.error, surface);
  if (run.stopReason === undefined) return [];
  return run.stopReason === 'conditions_unmet' && run.report !== undefined ? [run.stopReason, ...unmetConditionLines(run.report)] : [run.stopReason];
};

export const describeEnd = (run: RunView): string => describeRunEnd(run, 'cli');

export const describeRunEnd = (run: RunView, surface: Surface): string => {
  const head = `momonga: run ${run.id} ${run.status}`;
  const reason = endReasonLines(run, surface);
  if (reason.length === 0) return escapedLines([head]);
  const lines = [`${head} (${reason[0]}`, ...reason.slice(1)];
  lines[lines.length - 1] += ')';
  return escapedLines(lines);
};

const noteText = (lines: readonly string[]): string => `${escapedLines(lines)}\n`;

const leadWith = (prefix: string, lines: readonly string[]): string[] => lines.map((line, index) => (index === 0 ? `${prefix}${line}` : line));

export type PendingAsk = { id: string; answerWith: string };

export type FrameSink = {
  absorb(frame: RunEventFrame): void;
  handle(frame: RunEventFrame): void;
  handleChild(frame: RunEventFrame, agent: string): void;
  finalText(): string;
  texts(): string;
  pending(): number;
  unanswerable(): PendingAsk[];
  onQuiescent(listener: (resolved: QuiescentBehaviour | undefined) => void): void;
  onUnanswerable(listener: () => void): void;
};

type Ask = { runId: string; held: boolean; answerWith: string };

const approveCommand = (approvalId: string): string => `${WORDS.command} approve ${approvalId}`;

const awaitedOf = (awaits: Extract<PublicRunEvent, { type: 'tool.waiting' }>['awaits']): string =>
  awaits.kind === 'run' ? `subagent ${awaits.agent} (run ${awaits.runId})` : `job ${awaits.jobId}`;

const HELD_OUTCOME_WORDS = { executed: 'was approved and has run', rejected: 'was rejected and was not run', withdrawn: 'was withdrawn and was not run' } as const;

const BUDGET_CAUSE_WORDS = { limit: 'the limit is reached', unpriced: 'a model call has no price', cap_too_small: 'what is left does not pay for another request' } as const;

const budgetFigure = (dimension: string, value: number): string => (dimension === 'cost' ? `${usdOfNano(value)} USD` : `${value} ${dimension}`);

export const createFrameSink = (ports: Pick<CliPorts, 'stdout' | 'stderr'>, format: OutputFormat, verbose: boolean): FrameSink => {
  const items = new Map<string, string>();
  const titles = new Map<string, string>();
  let lastFailure: AttemptFailed | undefined;
  const open = new Map<string, Ask>();
  const waitingForPerson = new Set<string>();
  const found = new Map<string, string>();
  const quiescentListeners: Array<(resolved: QuiescentBehaviour | undefined) => void> = [];
  const unanswerableListeners: Array<() => void> = [];

  const unanswerable = (): PendingAsk[] => [...open].flatMap(([id, ask]) => (!ask.held && waitingForPerson.has(ask.runId) ? [{ id, answerWith: ask.answerWith }] : []));

  const unknownCallsOf = (callIds: readonly string[]): UnknownEffectCall[] =>
    callIds.map((callId) => {
      const text = found.get(callId);
      return { title: titles.get(callId) ?? callId, ...(text === undefined ? {} : { found: text }) };
    });

  const track = (event: PublicRunEvent): void => {
    if (event.type === 'tool.permission.requested' || event.type === 'tool.unknown.requested') open.set(event.approvalId, { runId: event.runId, held: false, answerWith: approveCommand(event.approvalId) });
    else if (event.type === 'tool.permission.resolved' || event.type === 'tool.permission.cancelled' || event.type === 'tool.unknown.resolved' || event.type === 'tool.unknown.cancelled') open.delete(event.approvalId);
    else if (event.type === 'tool.elicitation.requested') open.set(event.inputId, { runId: event.runId, held: false, answerWith: `${WORDS.command} elicit ${event.inputId}` });
    else if (event.type === 'tool.elicitation.resolved' || event.type === 'tool.elicitation.cancelled') open.delete(event.inputId);
    else if (event.type === 'tool.held') {
      const ask = open.get(event.approvalId);
      if (ask !== undefined) open.set(event.approvalId, { ...ask, held: true });
    } else if (event.type === 'run.status') {
      if (event.to === 'WAITING_HUMAN') waitingForPerson.add(event.runId);
      else waitingForPerson.delete(event.runId);
    }
    if (unanswerable().length > 0) for (const listener of unanswerableListeners) listener();
  };

  const note = (lines: readonly string[]): void => {
    ports.stderr.write(noteText(lines));
  };

  const present = (event: PublicRunEvent, agent: string | undefined): void => {
    const by = agent === undefined ? '' : ` (subagent ${agent})`;
    const ended = heldEndOf(event);
    if (ended !== undefined) note([`momonga: held call ${titles.get(ended.callId) ?? ended.callId} ${HELD_OUTCOME_WORDS[ended.outcome]}${ended.outcome === 'executed' ? ` (${ended.status})` : ''}`]);
    switch (event.type) {
      case 'tool.call':
        titles.set(event.callId, event.title);
        if (verbose) note([`momonga: ${event.name} ${event.title}`]);
        break;
      case 'tool.completed':
        if (verbose || event.status === 'failed') {
          const outcome = event.denial === undefined ? event.status : describeDenial(event.denial);
          const reason = event.status === 'failed' && event.effect !== undefined ? event.output.trimEnd() : '';
          note([`momonga: tool ${titles.get(event.callId) ?? event.callId} ${outcome}`, ...(reason === '' ? [] : reason.split('\n').map((line) => `  ${line}`))]);
        }
        break;
      case 'hook.completed':
        note(leadWith('momonga: ', describeHook(event, agent)));
        break;
      case 'verification.completed':
        note([`momonga: ${describeVerification(event, agent)}`]);
        break;
      case 'tool.permission.classified':
        note([`momonga: ${describeClassification(event, titles.get(event.callId) ?? event.callId)}`]);
        break;
      case 'tool.waiting':
        note([`momonga: waiting for ${awaitedOf(event.awaits)}`]);
        break;
      case 'tool.held':
        note([
          `momonga: held for approval ${event.approvalId}${by}: ${titles.get(event.callId) ?? event.callId}`,
          `  ${event.reason}`,
          '  the run goes on with work that does not depend on it',
          `  momonga approve ${event.approvalId} allow_once`,
          `  momonga approve ${event.approvalId} reject_once`,
        ]);
        break;
      case 'budget.exhausted':
        note([`momonga: budget exhausted: ${event.dimension} (${BUDGET_CAUSE_WORDS[event.cause]}); ${budgetFigure(event.dimension, event.spent)} of ${budgetFigure(event.dimension, event.limit)} used or reserved`]);
        break;
      case 'run.quiescent':
        note([
          `momonga: the run waits for you: ${event.held.length} call${event.held.length === 1 ? '' : 's'} held for approval, and nothing else can proceed`,
          ...event.held.flatMap((held) => [`  ${held.approvalId}  ${held.tool}: ${held.reason}`, `    momonga approve ${held.approvalId} allow_once`]),
        ]);
        if (agent === undefined) for (const listener of quiescentListeners) listener(event.onQuiescent);
        break;
      case 'tool.permission.requested':
        note([
          `momonga: waiting for approval ${event.approvalId}${by}: ${titles.get(event.callId) ?? event.callId}`,
          `  ${event.reason}`,
          ...approvalShownLines(event.shown).map((line) => `  ${line}`),
          ...event.options.map((option) => `  momonga approve ${event.approvalId} ${option.kind}`),
        ]);
        break;
      case 'tool.reconciled':
        found.set(event.callId, event.output);
        break;
      case 'tool.unknown.requested': {
        const calls = unknownCallsOf(event.callIds);
        note([
          `momonga: waiting for approval ${event.approvalId}${by}: ${unknownEffectTitle(calls)}`,
          ...unknownEffectLines(calls).map((line) => `  ${line}`),
          ...event.options.map((option) => `  momonga approve ${event.approvalId} ${option.kind}`),
        ]);
        break;
      }
      case 'tool.elicitation.requested':
        note(leadWith(`momonga: waiting for input${by} `, describeElicitation(event.inputId, event.server, titles.get(event.callId) ?? event.callId, event.requests)));
        break;
      case 'mcp.authorization.required':
        note([`momonga: ${mcpAuthorizationNotice(event.server)}`]);
        break;
      case 'notice':
        note([`momonga: ${event.level}: ${event.message}`]);
        break;
      case 'attempt.failed':
        lastFailure = event;
        break;
      case 'run.status':
        if (event.to === 'QUEUED' && lastFailure !== undefined) note([`momonga: ${describeRetryWait(lastFailure)}`]);
        break;
      case 'user.message':
      case 'run.started':
      case 'attempt.lost':
      case 'model.requested':
      case 'model.responded':
      case 'agent.message.delta':
      case 'agent.thought.delta':
      case 'model.stream.restarted':
      case 'tool.permission.classifying':
      case 'hook.started':
      case 'tool.permission.resolved':
      case 'tool.permission.cancelled':
      case 'tool.unknown.resolved':
      case 'tool.unknown.cancelled':
      case 'tool.elicitation.resolved':
      case 'tool.elicitation.cancelled':
      case 'tool.started':
      case 'tool.updated':
      case 'verification.started':
      case 'tool.loaded':
      case 'tool.offered':
      case 'loop.warned':
      case 'model.rejected':
      case 'meter.observed':
      case 'job.finished':
      case 'plan.updated':
      case 'mode.changed':
      case 'model.changed':
      case 'inbox.changed':
      case 'user_shell':
      case 'usage.updated':
      case 'usage.charged':
      case 'context.compacted':
      case 'context.inherited_compacted':
      case 'context.governing_loaded':
      case 'context.memories_loaded':
      case 'context.contribution':
      case 'context.compacting':
      case 'context.compaction_rejected':
      case 'context.inherited':
      case 'context.truncated':
      case 'instructions.loaded':
      case 'skill.activated':
      case 'user.compact':
      case 'approval.rule.persisted':
      case 'tool.held.resolved':
        break;
      default:
        noEventTypeLeft(event);
    }
  };

  const keep = (event: Extract<PublicRunEvent, { type: 'agent.message.delta' }>): void => {
    items.set(event.itemId, `${items.get(event.itemId) ?? ''}${event.text}`);
  };

  const withdraw = (event: Extract<PublicRunEvent, { type: 'model.stream.restarted' }>): void => {
    for (const itemId of event.itemIds) items.delete(itemId);
  };

  const absorb = (frame: RunEventFrame): void => {
    const event = frame.data;
    if (isOpaqueEvent(event)) return;
    track(event);
    if (event.type === 'tool.call') titles.set(event.callId, event.title);
    if (event.type === 'tool.reconciled') found.set(event.callId, event.output);
    if (event.type === 'agent.message.delta') keep(event);
    if (event.type === 'model.stream.restarted') withdraw(event);
  };

  const handle = (frame: RunEventFrame): void => {
    const event = frame.data;
    if (format === 'stream-json') ports.stdout.write(`${JSON.stringify(event)}\n`);
    if (isOpaqueEvent(event)) return;
    track(event);
    if (event.type === 'agent.message.delta') keep(event);
    else if (event.type === 'model.stream.restarted') withdraw(event);
    else present(event, undefined);
  };

  const handleChild = (frame: RunEventFrame, agent: string): void => {
    if (format === 'stream-json') ports.stdout.write(`${JSON.stringify(frame.data)}\n`);
    if (isOpaqueEvent(frame.data)) return;
    track(frame.data);
    const event = asChildEvent(frame.data, agent);
    if (event !== undefined) present(event, agent);
  };

  const finalText = (): string => [...items.values()].at(-1) ?? '';

  const texts = (): string => {
    let whole = '';
    for (const item of items.values()) whole += whole === '' || whole.endsWith('\n') || item === '' ? item : `\n${item}`;
    return whole === '' || whole.endsWith('\n') ? whole : `${whole}\n`;
  };

  return {
    absorb,
    handle,
    handleChild,
    finalText,
    texts,
    pending: () => open.size,
    unanswerable,
    onQuiescent: (listener) => void quiescentListeners.push(listener),
    onUnanswerable: (listener) => void unanswerableListeners.push(listener),
  };
};

export type WatchOptions = {
  client: RuntimeClient;
  runId: string;
  format: OutputFormat;
  verbose: boolean;
  leaveWhenQuiescent?: boolean;
  leaveWhenAsked?: boolean;
  after?: number;
  interrupt: AbortSignal;
  onInterrupt: 'cancel' | 'detach';
  move?: StreamMove;
};

type Leaving = 'quiescent' | 'asked' | 'detached';

export const watchRun = async (ports: CliPorts, paths: MomongaPaths, options: WatchOptions): Promise<number> => {
  const { client, runId } = options;
  const sink = createFrameSink(ports, options.format, options.verbose);
  const cancelOnInterrupt = (): void => {
    void client.cancel(runId).catch((error: unknown) => {
      ports.stderr.write(noteText([`momonga: cancel failed: ${error instanceof Error ? error.message : String(error)}`]));
    });
  };
  const writeTexts = (to: Pick<CliPorts['stdout'], 'write'>): void => {
    const texts = sink.texts();
    if (texts !== '') to.write(texts);
  };
  const leave = new AbortController();
  let leaving: Leaving | undefined;
  const leaveAs = (reason: Leaving): void => {
    leaving ??= reason;
    leave.abort();
  };
  const onInterrupt = options.onInterrupt === 'cancel' ? cancelOnInterrupt : (): void => leaveAs('detached');
  if (options.interrupt.aborted) onInterrupt();
  else options.interrupt.addEventListener('abort', onInterrupt, { once: true });
  let cursor = options.after ?? 0;
  let session: string | undefined;
  const { move } = options;
  const seen = (frame: RunEventFrame): void => {
    cursor = Math.max(cursor, frame.id);
    session ??= frame.data.sessionId;
  };
  const detach = move?.mover.attach(
    streamSurface({
      move,
      version: ports.version,
      runId,
      format: options.format,
      verbose: options.verbose,
      session: () => session,
      cursor: () => cursor,
      pending: sink.pending,
      say: (text) => ports.stderr.write(noteText([`momonga: ${text}`])),
    }),
  );
  const checkMove = (): void => {
    void move?.mover.check();
  };
  if (options.leaveWhenQuiescent === true) {
    sink.onQuiescent((resolved) => {
      if (resolved !== 'wait') leaveAs('quiescent');
    });
  }
  if (options.leaveWhenAsked === true) sink.onUnanswerable(() => leaveAs('asked'));
  let run: RunView;
  try {
    run = await followRun({
      client,
      signal: leave.signal,
      clock: ports.clock,
      random: ports.random,
      runId,
      ...(options.after === undefined ? {} : { seenThrough: options.after }),
      onSeenEvent: (frame) => {
        seen(frame);
        sink.absorb(frame);
      },
      reconnectBoundMs: await daemonReadyBoundMs(),
      restoreConnection: restoreDaemon(ports, paths, newerListenerOf(ports)),
      onEvent: (frame) => {
        seen(frame);
        sink.handle(frame);
        checkMove();
      },
      onChildEvent: (frame, agent) => {
        sink.handleChild(frame, agent);
        checkMove();
      },
      onReconnecting: (attempt) => ports.stderr.write(`momonga: lost the event stream, reconnecting (attempt ${attempt + 1})\n`),
    });
  } catch (error) {
    if (leaving === undefined) throw error;
    options.interrupt.removeEventListener('abort', onInterrupt);
    const left = await client.getRun(runId);
    if (options.format === 'text') writeTexts(ports.stderr);
    else ports.stdout.write(`${JSON.stringify(resultOf(left, sink.finalText()))}\n`);
    if (leaving === 'asked') {
      ports.stderr.write(
        noteText([
          `momonga: ${WORDS.run} ${runId} waits for an answer this command cannot give, and stays in the ${WORDS.daemon}; it goes on when you answer:`,
          ...sink.unanswerable().map((ask) => `  ${ask.id}  ${ask.answerWith}`),
          `  ${attachRunCommand(runId)} follows the ${WORDS.run} again`,
        ]),
      );
      return EXIT_WAITING_FOR_APPROVAL;
    }
    if (leaving === 'detached') {
      ports.stderr.write(noteText([`momonga: detached from ${WORDS.run} ${runId}, which is ${left.status} and stays in the ${WORDS.daemon}; ${attachRunCommand(runId)} follows it again, and ${WORDS.command} cancel ${runId} ends it`]));
      return EXIT_INTERRUPTED;
    }
    ports.stderr.write(noteText([`momonga: run ${runId} stays in the daemon; it resumes when you answer (momonga approve <id> allow_once), and momonga attach ${runId} follows it`]));
    return EXIT_WAITING_FOR_APPROVAL;
  } finally {
    detach?.();
  }
  options.interrupt.removeEventListener('abort', onInterrupt);
  if (options.format === 'text') writeTexts(run.status === 'COMPLETED' ? ports.stdout : ports.stderr);
  else ports.stdout.write(`${JSON.stringify(resultOf(run, sink.finalText()))}\n`);
  if (run.status === 'COMPLETED') return EXIT_OK;
  ports.stderr.write(`${describeEnd(run)}\n`);
  return run.status === 'CANCELLED' ? EXIT_INTERRUPTED : EXIT_FAILURE;
};

const modelsAnnounced = async (ports: CliPorts, interrupt: AbortSignal): Promise<boolean> => {
  try {
    await shellModelsOf(ports, interrupt);
    return true;
  } catch (error) {
    if (interrupt.aborted && error === interrupt.reason) return false;
    throw error;
  }
};

const openInterruptibleSession = async (ports: CliPorts, paths: MomongaPaths, options: HeadlessOptions): Promise<CliSession | undefined> => {
  try {
    const typed = {
      signal: options.interrupt,
      ...onNewerOf(ports),
      ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
      ...(options.bypassAllowed === undefined ? {} : { bypassAllowed: options.bypassAllowed }),
      ...(options.sandboxNetwork === undefined ? {} : { sandboxNetwork: options.sandboxNetwork }),
      ...(options.model === undefined ? {} : { model: options.model }),
    };
    return await openSession(ports, paths, options.reopen === undefined ? typed : { ...typed, reopen: options.reopen, modelList: options.modelList });
  } catch (error) {
    if (options.interrupt.aborted && error === options.interrupt.reason) return undefined;
    throw error;
  }
};

const onNewerOf = (ports: Pick<CliPorts, 'handover'>): { onNewer?: NewerListener } => {
  const onNewer = newerListenerOf(ports);
  return onNewer === undefined ? {} : { onNewer };
};

export const resumeStream = async (ports: CliPorts, paths: MomongaPaths, adopted: { record: StreamRecord; file: string }, interrupt: AbortSignal): Promise<number> => {
  const { record, file } = adopted;
  await ensureSessionDaemon(ports, paths, { signal: interrupt, ...onNewerOf(ports) });
  const client = connectSessionRuntime(ports, paths, newerListenerOf(ports));
  try {
    await client.getRun(record.runId);
    ports.handover?.removeRecord(file);
    const move = streamMoveOf(ports, paths, record.kind);
    return await watchRun(ports, paths, { client, runId: record.runId, format: record.output, verbose: record.verbose, after: record.lastSeq[record.runId] ?? 0, interrupt, onInterrupt: record.kind === 'attach' ? 'detach' : 'cancel', leaveWhenQuiescent: record.kind === 'headless', leaveWhenAsked: record.kind === 'headless', ...(move === undefined ? {} : { move }) });
  } finally {
    await client.close();
  }
};

export type RefusedResult = { type: 'result'; subtype: 'error'; is_error: true; result: ''; error: { code: string; message: string } };

const NOT_STARTED = 'run_not_started';

const writeRefusedResult = (ports: Pick<CliPorts, 'stdout'>, format: OutputFormat, code: string, message: string): void => {
  if (format === 'text') return;
  const refused: RefusedResult = { type: 'result', subtype: 'error', is_error: true, result: '', error: { code, message } };
  ports.stdout.write(`${JSON.stringify(refused)}\n`);
};

const refusedBeforeRun = (ports: Pick<CliPorts, 'stdout'>, format: OutputFormat, error: unknown): void => {
  if (error instanceof RunApiError) writeRefusedResult(ports, format, error.code === undefined ? NOT_STARTED : error.code, error.reason);
  else writeRefusedResult(ports, format, NOT_STARTED, error instanceof Error ? error.message : String(error));
};

const refuse = (ports: CliPorts, paths: MomongaPaths, format: OutputFormat, error: { reason: string }): number => {
  ports.stderr.write(`${escapedLines(leadWith('momonga: ', error.reason.split('\n')))}\n`);
  writeRefusedResult(ports, format, TARGET_NOT_READY, error.reason);
  return EXIT_FAILURE;
};

const MODEL_PARAM = 'model';

const isModelRefusal = (error: RunApiError): boolean => isRecord(error.body) && isRecord(error.body['error']) && error.body['error']['param'] === MODEL_PARAM;

export const runHeadless = async (ports: CliPorts, paths: MomongaPaths, options: HeadlessOptions): Promise<number> => {
  const adoption = adoptionOf(ports.handover?.started, ['headless']);
  if (adoption.kind === 'refused') return refuseStart({ stderr: ports.stderr }, adoption);
  if (adoption.kind === 'record') return resumeStream(ports, paths, adoption, options.interrupt);
  const move = streamMoveOf(ports, paths, 'headless');
  if (!(await modelsAnnounced(ports, options.interrupt))) return EXIT_INTERRUPTED;
  let session: CliSession | undefined;
  try {
    session = await openInterruptibleSession(ports, paths, options);
  } catch (error) {
    if ((error instanceof RunApiError || error instanceof NoModelConnected) && error.code === TARGET_NOT_READY) return refuse(ports, paths, options.format, error);
    if (error instanceof RunApiError && isModelRefusal(error)) {
      ports.stderr.write(`${escapedLines([`momonga: ${error.reason}`])}\n`);
      refusedBeforeRun(ports, options.format, error);
      return EXIT_FAILURE;
    }
    refusedBeforeRun(ports, options.format, error);
    throw error;
  }
  if (session === undefined) return EXIT_INTERRUPTED;
  const opened = session;
  try {
    const started = await startedRun(ports, opened, options).catch((error: unknown) => {
      refusedBeforeRun(ports, options.format, error);
      throw error;
    });
    if (started.kind === 'refused') return EXIT_FAILURE;
    if (started.kind === 'interrupted') return EXIT_INTERRUPTED;
    return await watchRun(ports, paths, { client: opened.client, runId: started.id, format: options.format, verbose: options.verbose, leaveWhenQuiescent: true, leaveWhenAsked: true, interrupt: options.interrupt, onInterrupt: 'cancel', ...(move === undefined ? {} : { move }) });
  } finally {
    await opened.close();
  }
};

type RunStart = { kind: 'started'; id: string } | { kind: 'refused' } | { kind: 'interrupted' };

const startedRun = async (ports: CliPorts, session: CliSession, options: HeadlessOptions): Promise<RunStart> => {
  if (session.created.trustNotice !== undefined) ports.stderr.write(noteText([`momonga: ${session.created.trustNotice}`]));
  const readiness = agentReadiness(await options.capabilitiesOf(session.created.session.model));
  if (readiness.state === 'probing') ports.stderr.write(`${escapedLines([`momonga: ${readiness.message}`])}\n`);
  if (readiness.state === 'needs_probe' || readiness.state === 'unavailable') {
    const message = readinessShownText(readiness, 'shell');
    ports.stderr.write(`${escapedLines(leadWith('momonga: ', message.split('\n')))}\n`);
    writeRefusedResult(ports, options.format, TARGET_NOT_READY, message);
    return { kind: 'refused' };
  }
  if (readiness.state === 'no_tools') ports.stderr.write(`${escapedLines(leadWith('momonga: warning: ', readinessShownText(readiness, 'shell').split('\n')))}\n`);
  const sessionId = session.created.session.id;
  const invocation = await resolveSkillInvocation(session.client, sessionId, options.prompt, options.skill);
  const images = await Promise.all((options.images ?? []).map((file) => readImageAttachment(ports.files, ports.cwd, file)));
  if (options.interrupt.aborted) return { kind: 'interrupted' };
  const { run: started } = await session.client.createRun(sessionId, invocation.input, {
    ...(invocation.skill === undefined ? {} : { skill: invocation.skill }),
    ...(images.length === 0 ? {} : { images }),
    ...(options.mandate === undefined ? {} : { mandate: options.mandate }),
    ...(options.issue === undefined ? {} : { issue: options.issue }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  if (options.format === 'stream-json') {
    ports.stdout.write(
      `${JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, run_id: started.id, cwd: ports.cwd, permission_mode: session.created.session.permissionMode, stripped_env_keys: session.created.strippedEnvKeys })}\n`,
    );
  }
  return { kind: 'started', id: started.id };
};
