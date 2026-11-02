import type { MomongaPaths } from '@momonga/foundation';
import type { PermissionMode } from '@momonga/protocol';
import type { RunEventFrame, RuntimeClient } from '../client/runtime-client.ts';
import type { RunView } from '../client/views.ts';
import { daemonReadyBoundMs, ensureDaemon } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import { followRun } from './follow.ts';
import { openSession } from './open-session.ts';

export const OUTPUT_FORMATS = ['text', 'json', 'stream-json'] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export const EXIT_RUN_FAILED = 1;
export const EXIT_INTERRUPTED = 130;

export type HeadlessOptions = {
  prompt: string;
  format: OutputFormat;
  permissionMode?: PermissionMode;
  bypassAllowed?: boolean;
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

export const describeEnd = (run: RunView): string => {
  const reason = run.error === undefined ? run.stopReason : `${run.error.code}: ${run.error.message}`;
  return `momonga: run ${run.id} ${run.status}${reason === undefined ? '' : ` (${reason})`}`;
};

export type FrameSink = { handle(frame: RunEventFrame): void; finalText(): string };

export const createFrameSink = (ports: Pick<CliPorts, 'stdout' | 'stderr'>, format: OutputFormat, verbose: boolean): FrameSink => {
  const items = new Map<string, string>();
  const titles = new Map<string, string>();
  let lastItem: string | undefined;
  let needsNewline = false;

  const note = (text: string): void => {
    ports.stderr.write(`${text}\n`);
  };

  const handle = (frame: RunEventFrame): void => {
    const event = frame.data;
    if (format === 'stream-json') ports.stdout.write(`${JSON.stringify(event)}\n`);
    switch (event.type) {
      case 'agent.message.delta': {
        items.set(event.itemId, `${items.get(event.itemId) ?? ''}${event.text}`);
        if (format !== 'text') break;
        if (lastItem !== undefined && lastItem !== event.itemId && needsNewline) ports.stdout.write('\n');
        lastItem = event.itemId;
        ports.stdout.write(event.text);
        needsNewline = !event.text.endsWith('\n');
        break;
      }
      case 'tool.call':
        titles.set(event.callId, event.title);
        if (verbose) note(`momonga: ${event.name} ${event.title}`);
        break;
      case 'tool.completed':
        if (verbose || event.status === 'failed') note(`momonga: tool ${titles.get(event.callId) ?? event.callId} ${event.status}`);
        break;
      case 'tool.permission.requested':
        note(
          [
            `momonga: waiting for approval ${event.approvalId}: ${titles.get(event.callId) ?? event.callId}`,
            ...event.options.map((option) => `  momonga approve ${event.approvalId} ${option.kind}`),
          ].join('\n'),
        );
        break;
      case 'notice':
        note(`momonga: ${event.level}: ${event.message}`);
        break;
      default:
        break;
    }
  };

  const finalText = (): string => [...items.values()].at(-1) ?? '';
  return { handle, finalText };
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
      ports.stderr.write(`momonga: cancel failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  };
  options.interrupt.addEventListener('abort', cancelOnInterrupt, { once: true });
  const run = await followRun({
    client,
    clock: ports.clock,
    random: ports.random,
    runId,
    ...(options.after === undefined ? {} : { after: options.after }),
    reconnectBoundMs: await daemonReadyBoundMs(),
    restoreConnection: async () => {
      await ensureDaemon(ports, paths);
    },
    onEvent: sink.handle,
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
  return run.status === 'CANCELLED' && options.interrupt.aborted ? EXIT_INTERRUPTED : EXIT_RUN_FAILED;
};

export const runHeadless = async (ports: CliPorts, paths: MomongaPaths, options: HeadlessOptions): Promise<number> => {
  const session = await openSession(ports, paths, {
    ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
    ...(options.bypassAllowed === undefined ? {} : { bypassAllowed: options.bypassAllowed }),
  });
  try {
    const sessionId = session.created.session.id;
    const { run: started } = await session.client.createRun(sessionId, options.prompt);
    if (options.format === 'stream-json') {
      ports.stdout.write(
        `${JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, run_id: started.id, cwd: ports.cwd, permission_mode: session.created.session.permissionMode })}\n`,
      );
    }
    return await watchRun(ports, paths, { client: session.client, runId: started.id, format: options.format, verbose: options.verbose, interrupt: options.interrupt });
  } finally {
    await session.close();
  }
};
