import { EXIT_FAILURE, EXIT_INTERRUPTED, EXIT_OK, EXIT_WAITING_FOR_APPROVAL, isRecord } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { TARGET_NOT_READY, agentReadiness, readinessShownText, unknownEffectLines, unknownEffectTitle, usdOfNano } from '@momonga/protocol';
import type { BudgetExhausted, Mandate, MomongaModelEntry, PermissionMode, PlanAccountRef, PublicRunEvent, RunReport, Surface, UnknownEffectCall } from '@momonga/protocol';
import { noTargetLines } from '../readiness.ts';
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
import { connectSessionRuntime, openSession } from './open-session.ts';
import type { CliSession } from './open-session.ts';
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
  model?: string;
  reopen?: HeadlessReopen;
  capabilitiesOf(model: string): Promise<MomongaModelEntry['capabilities']>;
  skill?: string;
  images?: readonly string[];
  mandate?: Mandate;
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

export type FrameSink = {
  absorb(frame: RunEventFrame): void;
  handle(frame: RunEventFrame): void;
  handleChild(frame: RunEventFrame, agent: string): void;
  finalText(): string;
  pending(): number;
  onQuiescent(listener: () => void): void;
};

const awaitedOf = (awaits: Extract<PublicRunEvent, { type: 'tool.waiting' }>['awaits']): string =>
  awaits.kind === 'run' ? `subagent ${awaits.agent} (run ${awaits.runId})` : `job ${awaits.jobId}`;

const HELD_OUTCOME_WORDS = { executed: 'was approved and has run', rejected: 'was rejected and was not run', withdrawn: 'was withdrawn and was not run' } as const;

const BUDGET_CAUSE_WORDS = { limit: 'the limit is reached', unpriced: 'a model call has no price', cap_too_small: 'what is left does not pay for another request' } as const;

const budgetFigure = (dimension: string, value: number): string => (dimension === 'cost' ? `${usdOfNano(value)} USD` : `${value} ${dimension}`);

export const createFrameSink = (ports: Pick<CliPorts, 'stdout' | 'stderr'>, format: OutputFormat, verbose: boolean): FrameSink => {
  const items = new Map<string, string>();
  const titles = new Map<string, string>();
  let lastItem: string | undefined;
  let needsNewline = false;
  let lastFailure: AttemptFailed | undefined;
  const open = new Set<string>();
  const found = new Map<string, string>();
  const quiescentListeners: Array<() => void> = [];

  const unknownCallsOf = (callIds: readonly string[]): UnknownEffectCall[] =>
    callIds.map((callId) => {
      const text = found.get(callId);
      return { title: titles.get(callId) ?? callId, ...(text === undefined ? {} : { found: text }) };
    });

  const track = (event: PublicRunEvent): void => {
    if (event.type === 'tool.permission.requested' || event.type === 'tool.unknown.requested') open.add(event.approvalId);
    else if (event.type === 'tool.permission.resolved' || event.type === 'tool.permission.cancelled' || event.type === 'tool.unknown.resolved' || event.type === 'tool.unknown.cancelled') open.delete(event.approvalId);
    else if (event.type === 'tool.elicitation.requested') open.add(event.inputId);
    else if (event.type === 'tool.elicitation.resolved' || event.type === 'tool.elicitation.cancelled') open.delete(event.inputId);
  };

  const note = (lines: readonly string[]): void => {
    ports.stderr.write(noteText(lines));
  };

  const present = (event: PublicRunEvent, agent: string | undefined): void => {
    const by = agent === undefined ? '' : ` (subagent ${agent})`;
    switch (event.type) {
      case 'tool.call':
        titles.set(event.callId, event.title);
        if (verbose) note([`momonga: ${event.name} ${event.title}`]);
        break;
      case 'tool.completed':
        if (verbose || event.status === 'failed') {
          const outcome = event.denial === undefined ? event.status : describeDenial(event.denial);
          note([`momonga: tool ${titles.get(event.callId) ?? event.callId} ${outcome}`]);
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
      case 'tool.held.resolved':
        note([`momonga: held call ${titles.get(event.callId) ?? event.callId} ${HELD_OUTCOME_WORDS[event.outcome]}${event.outcome === 'executed' ? ` (${event.status})` : ''}`]);
        break;
      case 'budget.exhausted':
        note([`momonga: budget exhausted: ${event.dimension} (${BUDGET_CAUSE_WORDS[event.cause]}); ${budgetFigure(event.dimension, event.spent)} of ${budgetFigure(event.dimension, event.limit)} used or reserved`]);
        break;
      case 'run.quiescent':
        note([
          `momonga: the run waits for you: ${event.held.length} call${event.held.length === 1 ? '' : 's'} held for approval, and nothing else can proceed`,
          ...event.held.flatMap((held) => [`  ${held.approvalId}  ${held.tool}: ${held.reason}`, `    momonga approve ${held.approvalId} allow_once`]),
        ]);
        if (agent === undefined) for (const listener of quiescentListeners) listener();
        break;
      case 'tool.permission.requested':
        note([
          `momonga: waiting for approval ${event.approvalId}${by}: ${titles.get(event.callId) ?? event.callId}`,
          `  ${event.reason}`,
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
      case 'context.governing_loaded':
      case 'context.memories_loaded':
      case 'context.contribution':
      case 'context.compacting':
      case 'context.compaction_rejected':
      case 'context.inherited':
      case 'context.truncated':
      case 'instructions.loaded':
      case 'skill.activated':
      case 'approval.rule.persisted':
        break;
      default:
        noEventTypeLeft(event);
    }
  };

  const keep = (event: Extract<PublicRunEvent, { type: 'agent.message.delta' }>): void => {
    items.set(event.itemId, `${items.get(event.itemId) ?? ''}${event.text}`);
    lastItem = event.itemId;
    needsNewline = !event.text.endsWith('\n');
  };

  const absorb = (frame: RunEventFrame): void => {
    const event = frame.data;
    track(event);
    if (event.type === 'tool.call') titles.set(event.callId, event.title);
    if (event.type === 'tool.reconciled') found.set(event.callId, event.output);
    if (event.type === 'agent.message.delta') keep(event);
  };

  const handle = (frame: RunEventFrame): void => {
    const event = frame.data;
    track(event);
    if (format === 'stream-json') ports.stdout.write(`${JSON.stringify(event)}\n`);
    if (event.type !== 'agent.message.delta') {
      present(event, undefined);
      return;
    }
    if (format === 'text' && lastItem !== undefined && lastItem !== event.itemId && needsNewline) ports.stdout.write('\n');
    keep(event);
    if (format === 'text') ports.stdout.write(event.text);
  };

  const handleChild = (frame: RunEventFrame, agent: string): void => {
    track(frame.data);
    if (format === 'stream-json') ports.stdout.write(`${JSON.stringify(frame.data)}\n`);
    const event = asChildEvent(frame.data, agent);
    if (event !== undefined) present(event, agent);
  };

  const finalText = (): string => [...items.values()].at(-1) ?? '';
  return { absorb, handle, handleChild, finalText, pending: () => open.size, onQuiescent: (listener) => void quiescentListeners.push(listener) };
};

export type WatchOptions = {
  client: RuntimeClient;
  runId: string;
  format: OutputFormat;
  verbose: boolean;
  leaveWhenQuiescent?: boolean;
  after?: number;
  interrupt: AbortSignal;
  move?: StreamMove;
};

export const watchRun = async (ports: CliPorts, paths: MomongaPaths, options: WatchOptions): Promise<number> => {
  const { client, runId } = options;
  const sink = createFrameSink(ports, options.format, options.verbose);
  const cancelOnInterrupt = (): void => {
    void client.cancel(runId).catch((error: unknown) => {
      ports.stderr.write(noteText([`momonga: cancel failed: ${error instanceof Error ? error.message : String(error)}`]));
    });
  };
  if (options.interrupt.aborted) cancelOnInterrupt();
  else options.interrupt.addEventListener('abort', cancelOnInterrupt, { once: true });
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
  const quiescent = new AbortController();
  if (options.leaveWhenQuiescent === true) sink.onQuiescent(() => quiescent.abort());
  let run: RunView;
  try {
    run = await followRun({
      client,
      signal: quiescent.signal,
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
    if (!quiescent.signal.aborted) throw error;
    options.interrupt.removeEventListener('abort', cancelOnInterrupt);
    const waiting = await client.getRun(runId);
    if (options.format !== 'text') ports.stdout.write(`${JSON.stringify(resultOf(waiting, sink.finalText()))}\n`);
    ports.stderr.write(noteText([`momonga: run ${runId} stays in the daemon; it resumes when you answer (momonga approve <id> allow_once), and momonga attach ${runId} follows it`]));
    return EXIT_WAITING_FOR_APPROVAL;
  } finally {
    detach?.();
  }
  options.interrupt.removeEventListener('abort', cancelOnInterrupt);
  const text = sink.finalText();
  if (options.format === 'text') {
    if (text !== '' && !text.endsWith('\n')) ports.stdout.write('\n');
  } else {
    ports.stdout.write(`${JSON.stringify(resultOf(run, text))}\n`);
  }
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
    return await openSession(ports, paths, {
      signal: options.interrupt,
      ...onNewerOf(ports),
      ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
      ...(options.bypassAllowed === undefined ? {} : { bypassAllowed: options.bypassAllowed }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.reopen === undefined ? {} : { reopen: options.reopen }),
    });
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
    return await watchRun(ports, paths, { client, runId: record.runId, format: record.output, verbose: record.verbose, after: record.lastSeq[record.runId] ?? 0, interrupt, ...(move === undefined ? {} : { move }) });
  } finally {
    await client.close();
  }
};

export type RefusedResult = { type: 'result'; subtype: 'error'; is_error: true; result: ''; error: { code: string; message: string } };

const refuse = (ports: CliPorts, paths: MomongaPaths, format: OutputFormat, error: RunApiError): number => {
  ports.stderr.write(`${escapedLines(leadWith('momonga: ', noTargetLines(error.reason, paths)))}\n`);
  if (format !== 'text') {
    const refused: RefusedResult = { type: 'result', subtype: 'error', is_error: true, result: '', error: { code: TARGET_NOT_READY, message: error.reason } };
    ports.stdout.write(`${JSON.stringify(refused)}\n`);
  }
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
    if (error instanceof RunApiError && error.code === TARGET_NOT_READY) return refuse(ports, paths, options.format, error);
    if (error instanceof RunApiError && isModelRefusal(error)) {
      ports.stderr.write(`${escapedLines([`momonga: ${error.reason}`])}\n`);
      return EXIT_FAILURE;
    }
    throw error;
  }
  if (session === undefined) return EXIT_INTERRUPTED;
  try {
    const readiness = agentReadiness(await options.capabilitiesOf(session.created.session.model));
    if (readiness.state === 'probing') ports.stderr.write(`${escapedLines([`momonga: ${readiness.message}`])}\n`);
    if (readiness.state === 'needs_probe' || readiness.state === 'unavailable') {
      const message = readinessShownText(readiness, 'shell');
      ports.stderr.write(`${escapedLines(leadWith(`momonga: ${TARGET_NOT_READY}: `, message.split('\n')))}\n`);
      if (options.format !== 'text') {
        const refused: RefusedResult = { type: 'result', subtype: 'error', is_error: true, result: '', error: { code: TARGET_NOT_READY, message } };
        ports.stdout.write(`${JSON.stringify(refused)}\n`);
      }
      return EXIT_FAILURE;
    }
    if (readiness.state === 'no_tools') ports.stderr.write(`${escapedLines(leadWith('momonga: warning: ', readinessShownText(readiness, 'shell').split('\n')))}\n`);
    const sessionId = session.created.session.id;
    const invocation = await resolveSkillInvocation(session.client, sessionId, options.prompt, options.skill);
    const images = await Promise.all((options.images ?? []).map((file) => readImageAttachment(ports.files, ports.cwd, file)));
    if (options.interrupt.aborted) return EXIT_INTERRUPTED;
    const { run: started } = await session.client.createRun(sessionId, invocation.input, {
      ...(invocation.skill === undefined ? {} : { skill: invocation.skill }),
      ...(images.length === 0 ? {} : { images }),
      ...(options.mandate === undefined ? {} : { mandate: options.mandate }),
      ...(options.limits === undefined ? {} : { limits: options.limits }),
    });
    if (options.format === 'stream-json') {
      ports.stdout.write(
        `${JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, run_id: started.id, cwd: ports.cwd, permission_mode: session.created.session.permissionMode, stripped_env_keys: session.created.strippedEnvKeys })}\n`,
      );
    }
    return await watchRun(ports, paths, { client: session.client, runId: started.id, format: options.format, verbose: options.verbose, leaveWhenQuiescent: options.mandate?.hold?.onQuiescent !== 'wait', interrupt: options.interrupt, ...(move === undefined ? {} : { move }) });
  } finally {
    await session.close();
  }
};
