import type { MomongaPaths } from '@momonga/foundation';
import { TARGET_NOT_READY } from '@momonga/protocol';
import type { PermissionMode, PublicRunEvent } from '@momonga/protocol';
import { noTargetLines } from '../readiness.ts';
import { RunApiError } from '../client/runtime-client.ts';
import type { RunEventFrame, RuntimeClient } from '../client/runtime-client.ts';
import type { RunView } from '../client/views.ts';
import { daemonReadyBoundMs, restoreDaemon } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import { escapedLines } from '../terminal-writer.ts';
import { describeElicitation } from '../elicit/describe.ts';
import { readImageAttachment } from '../images.ts';
import { mcpAuthorizationNotice } from '../mcp/messages.ts';
import { describeClassification, describeDenial, describeHook, describeRunError } from '../policy-messages.ts';
import { asChildEvent } from './child-events.ts';
import { followRun } from './follow.ts';
import { openSession } from './open-session.ts';
import type { CliSession } from './open-session.ts';
import { resolveSkillInvocation } from './skill-invocation.ts';

export const OUTPUT_FORMATS = ['text', 'json', 'stream-json'] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export const EXIT_RUN_FAILED = 1;
export const EXIT_CANCELLED = 130;

export type HeadlessOptions = {
  prompt: string;
  format: OutputFormat;
  permissionMode?: PermissionMode;
  bypassAllowed?: boolean;
  modelAlias?: string;
  skill?: string;
  images?: readonly string[];
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
  error?: { code: string; message: string };
  num_turns: number;
  usage: RunView['usage'];
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
});

const endReasonLines = (run: RunView): string[] => {
  if (run.error !== undefined) return describeRunError(run.error);
  return run.stopReason === undefined ? [] : [run.stopReason];
};

export const describeEnd = (run: RunView): string => {
  const head = `momonga: run ${run.id} ${run.status}`;
  const reason = endReasonLines(run);
  if (reason.length === 0) return escapedLines([head]);
  const lines = [`${head} (${reason[0]}`, ...reason.slice(1)];
  lines[lines.length - 1] += ')';
  return escapedLines(lines);
};

const noteText = (lines: readonly string[]): string => `${escapedLines(lines)}\n`;

const leadWith = (prefix: string, lines: readonly string[]): string[] => lines.map((line, index) => (index === 0 ? `${prefix}${line}` : line));

export type FrameSink = { absorb(frame: RunEventFrame): void; handle(frame: RunEventFrame): void; handleChild(frame: RunEventFrame, agent: string): void; finalText(): string };

const awaitedOf = (awaits: Extract<PublicRunEvent, { type: 'tool.waiting' }>['awaits']): string =>
  awaits.kind === 'run' ? `subagent ${awaits.agent} (run ${awaits.runId})` : `job ${awaits.jobId}`;

export const createFrameSink = (ports: Pick<CliPorts, 'stdout' | 'stderr'>, format: OutputFormat, verbose: boolean): FrameSink => {
  const items = new Map<string, string>();
  const titles = new Map<string, string>();
  let lastItem: string | undefined;
  let needsNewline = false;

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
      case 'tool.permission.classified':
        note([`momonga: ${describeClassification(event, titles.get(event.callId) ?? event.callId)}`]);
        break;
      case 'tool.waiting':
        note([`momonga: waiting for ${awaitedOf(event.awaits)}`]);
        break;
      case 'tool.permission.requested':
        note([
          `momonga: waiting for approval ${event.approvalId}${by}: ${titles.get(event.callId) ?? event.callId}`,
          `  ${event.reason}`,
          ...event.options.map((option) => `  momonga approve ${event.approvalId} ${option.kind}`),
        ]);
        break;
      case 'tool.elicitation.requested':
        note(leadWith(`momonga: waiting for input${by} `, describeElicitation(event.inputId, event.server, titles.get(event.callId) ?? event.callId, event.requests)));
        break;
      case 'mcp.authorization.required':
        note([`momonga: ${mcpAuthorizationNotice(event.server)}`]);
        break;
      case 'notice':
        note([`momonga: ${event.level}: ${event.message}`]);
        break;
      default:
        break;
    }
  };

  const absorb = (frame: RunEventFrame): void => {
    const event = frame.data;
    if (event.type === 'tool.call') titles.set(event.callId, event.title);
    if (event.type === 'agent.message.delta') items.set(event.itemId, `${items.get(event.itemId) ?? ''}${event.text}`);
  };

  const handle = (frame: RunEventFrame): void => {
    const event = frame.data;
    if (format === 'stream-json') ports.stdout.write(`${JSON.stringify(event)}\n`);
    if (event.type !== 'agent.message.delta') {
      present(event, undefined);
      return;
    }
    items.set(event.itemId, `${items.get(event.itemId) ?? ''}${event.text}`);
    if (format !== 'text') return;
    if (lastItem !== undefined && lastItem !== event.itemId && needsNewline) ports.stdout.write('\n');
    lastItem = event.itemId;
    ports.stdout.write(event.text);
    needsNewline = !event.text.endsWith('\n');
  };

  const handleChild = (frame: RunEventFrame, agent: string): void => {
    if (format === 'stream-json') ports.stdout.write(`${JSON.stringify(frame.data)}\n`);
    const event = asChildEvent(frame.data, agent);
    if (event !== undefined) present(event, agent);
  };

  const finalText = (): string => [...items.values()].at(-1) ?? '';
  return { absorb, handle, handleChild, finalText };
};

export type WatchOptions = {
  client: RuntimeClient;
  runId: string;
  format: OutputFormat;
  verbose: boolean;
  after?: number;
  interrupt: AbortSignal;
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
  const run = await followRun({
    client,
    clock: ports.clock,
    random: ports.random,
    runId,
    ...(options.after === undefined ? {} : { seenThrough: options.after }),
    onSeenEvent: sink.absorb,
    reconnectBoundMs: await daemonReadyBoundMs(),
    restoreConnection: restoreDaemon(ports, paths),
    onEvent: sink.handle,
    onChildEvent: sink.handleChild,
    onReconnecting: (attempt) => ports.stderr.write(`momonga: lost the event stream, reconnecting (attempt ${attempt + 1})\n`),
  });
  options.interrupt.removeEventListener('abort', cancelOnInterrupt);
  const text = sink.finalText();
  if (options.format === 'text') {
    if (text !== '' && !text.endsWith('\n')) ports.stdout.write('\n');
  } else {
    ports.stdout.write(`${JSON.stringify(resultOf(run, text))}\n`);
  }
  if (run.status === 'COMPLETED') return 0;
  ports.stderr.write(`${describeEnd(run)}\n`);
  return run.status === 'CANCELLED' ? EXIT_CANCELLED : EXIT_RUN_FAILED;
};

const openInterruptibleSession = async (ports: CliPorts, paths: MomongaPaths, options: HeadlessOptions): Promise<CliSession | undefined> => {
  try {
    return await openSession(ports, paths, {
      signal: options.interrupt,
      ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
      ...(options.bypassAllowed === undefined ? {} : { bypassAllowed: options.bypassAllowed }),
      ...(options.modelAlias === undefined ? {} : { modelAlias: options.modelAlias }),
    });
  } catch (error) {
    if (options.interrupt.aborted && error === options.interrupt.reason) return undefined;
    throw error;
  }
};

export type RefusedResult = { type: 'result'; subtype: 'error'; is_error: true; result: ''; error: { code: string; message: string } };

const refuse = (ports: CliPorts, paths: MomongaPaths, format: OutputFormat, error: RunApiError): number => {
  ports.stderr.write(`${escapedLines(leadWith('momonga: ', noTargetLines(error.reason, paths)))}\n`);
  if (format !== 'text') {
    const refused: RefusedResult = { type: 'result', subtype: 'error', is_error: true, result: '', error: { code: TARGET_NOT_READY, message: error.reason } };
    ports.stdout.write(`${JSON.stringify(refused)}\n`);
  }
  return EXIT_RUN_FAILED;
};

export const runHeadless = async (ports: CliPorts, paths: MomongaPaths, options: HeadlessOptions): Promise<number> => {
  let session: CliSession | undefined;
  try {
    session = await openInterruptibleSession(ports, paths, options);
  } catch (error) {
    if (error instanceof RunApiError && error.code === TARGET_NOT_READY) return refuse(ports, paths, options.format, error);
    throw error;
  }
  if (session === undefined) return EXIT_CANCELLED;
  try {
    const sessionId = session.created.session.id;
    const invocation = await resolveSkillInvocation(session.client, sessionId, options.prompt, options.skill);
    const images = await Promise.all((options.images ?? []).map((file) => readImageAttachment(ports.files, ports.cwd, file)));
    if (options.interrupt.aborted) return EXIT_CANCELLED;
    const { run: started } = await session.client.createRun(sessionId, invocation.input, {
      ...(invocation.skill === undefined ? {} : { skill: invocation.skill }),
      ...(images.length === 0 ? {} : { images }),
    });
    if (options.format === 'stream-json') {
      ports.stdout.write(
        `${JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, run_id: started.id, cwd: ports.cwd, permission_mode: session.created.session.permissionMode, stripped_env_keys: session.created.strippedEnvKeys })}\n`,
      );
    }
    return await watchRun(ports, paths, { client: session.client, runId: started.id, format: options.format, verbose: options.verbose, interrupt: options.interrupt });
  } finally {
    await session.close();
  }
};
