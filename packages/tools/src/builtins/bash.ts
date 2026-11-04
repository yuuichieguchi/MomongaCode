import { randomBytes } from 'node:crypto';
import { commandSpecsFor, readPathsOfCommand } from '@momonga/policy';
import { findHolders, reconcileProcessGroup, resolveToolPath, stoppedCommandResult } from '@momonga/foundation';
import { defineTool, ToolExecutionError } from '../types.ts';
import type { SandboxExit } from '@momonga/sandbox';
import type { BackgroundJobs } from '../ports.ts';
import type { ReconcileContext, ToolContext, ToolResult } from '../types.ts';
import { createCapture, pumpOutput } from '../capture.ts';
import { describeJobStatus } from './jobs.ts';
import { canonicalDirectories, insideAny, shownPath } from './paths.ts';
import { nodeShellPorts, resolveBashPath } from './shell.ts';

type BashInput = { command: string; timeout?: number; description?: string; run_in_background?: boolean };

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
export const DEFAULT_BACKGROUND_TIMEOUT_MS = 1_800_000;
export const MAX_BACKGROUND_TIMEOUT_MS = 7_200_000;
const TITLE_CHARS = 80;
const trapScript = (nonce: string): string =>
  `trap 'status=$?; printf "\\n__MOMONGA_CWD_${nonce}__=%s\\n" "$(pwd -P)"; exit $status' EXIT`;

const extractCwd = (output: string, nonce: string): { output: string; cwd: string | undefined } => {
  const prefix = `__MOMONGA_CWD_${nonce}__=`;
  const index = output.lastIndexOf(prefix);
  if (index === -1) return { output, cwd: undefined };
  const lineEnd = output.indexOf('\n', index);
  const cwd = output.slice(index + prefix.length, lineEnd === -1 ? output.length : lineEnd);
  const removeFrom = output[index - 1] === '\n' ? index - 1 : index;
  const removeTo = lineEnd === -1 ? output.length : lineEnd + 1;
  return { output: output.slice(0, removeFrom) + output.slice(removeTo), cwd };
};

const bashPathFor = (env: Readonly<Record<string, string>>): string => resolveBashPath(process.platform, { ...nodeShellPorts(), env });

const bashEnvOf = (env: Readonly<Record<string, string>>): Record<string, string> => ({ ...env, CDPATH: '', GIT_TERMINAL_PROMPT: '0', PAGER: 'cat', GIT_PAGER: 'cat' });

const requireMarker = (ctx: ToolContext): string => {
  if (ctx.processMarker === undefined) throw new ToolExecutionError('Bash needs a process marker from the executor');
  return ctx.processMarker;
};

const requireJobs = (ctx: ReconcileContext): BackgroundJobs => {
  if (ctx.jobs === undefined) throw new ToolExecutionError('Background jobs are not available in this runtime');
  return ctx.jobs;
};

const startBackgroundJob = async (input: BashInput, ctx: ToolContext): Promise<ToolResult> => {
  const { jobId } = await requireJobs(ctx).start({
    runId: ctx.runId,
    callKey: ctx.idemKey,
    callId: ctx.callId,
    command: input.command,
    timeoutMs: input.timeout ?? DEFAULT_BACKGROUND_TIMEOUT_MS,
    spawn: (markerFile, signal) =>
      ctx.sandbox.spawn(
        {
          argv: [bashPathFor(ctx.env), '-c', input.command],
          cwd: ctx.session.cwd,
          env: bashEnvOf(ctx.env),
          markerFile,
          ...(ctx.tmpDir === undefined ? {} : { tmpDir: ctx.tmpDir }),
        },
        ctx.sandboxPolicy,
        signal,
      ),
  });
  return {
    status: 'completed',
    output: `Started background job ${jobId}. Read its output with BashOutput (bash_id ${jobId}) and stop it with KillBash (shell_id ${jobId}).`,
  };
};

export const bashTool = defineTool<BashInput>({
  name: 'Bash',
  description: `Runs a shell command with /bin/bash inside a sandbox, in the current working directory. Output combines stdout and stderr. A cd that stays inside the workspace persists to later calls. timeout is in milliseconds (default ${DEFAULT_TIMEOUT_MS}, maximum ${MAX_TIMEOUT_MS}). No process started by the command outlives it. With run_in_background the command starts as a background job and the call returns its job id at once; read its output with BashOutput and stop it with KillBash. For a background job timeout is the time the job may run (default ${DEFAULT_BACKGROUND_TIMEOUT_MS}, maximum ${MAX_BACKGROUND_TIMEOUT_MS}); a job ends with its command, with KillBash, at its time limit, or when MomongaCode stops.`,
  conciseDescription: `Runs a bash command in a sandbox in the working directory; output is stdout and stderr. timeout is in milliseconds (default ${DEFAULT_TIMEOUT_MS}, maximum ${MAX_TIMEOUT_MS}). With run_in_background it returns a job id; use BashOutput and KillBash. A background job's timeout defaults to ${DEFAULT_BACKGROUND_TIMEOUT_MS}, maximum ${MAX_BACKGROUND_TIMEOUT_MS}.`,
  conciseParameterDescriptions: {
    command: 'Command to run',
    timeout: 'Timeout in milliseconds',
    description: 'What the command does',
    run_in_background: 'Run as a background job and return its job id',
  },
  kind: 'execute',
  sideEffect: 'exec',
  subjectKind: 'command',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', minLength: 1, description: 'The command to run' },
      timeout: { type: 'integer', minimum: 1, maximum: MAX_BACKGROUND_TIMEOUT_MS, description: 'Timeout in milliseconds' },
      description: { type: 'string', description: 'Short description of what the command does' },
      run_in_background: { type: 'boolean', description: 'Run the command as a background job and return its job id immediately' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  timeoutMs: (input) => Math.min(input.run_in_background === true ? DEFAULT_TIMEOUT_MS : (input.timeout ?? DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS),
  title: (input) => input.description ?? input.command.slice(0, TITLE_CHARS),
  subject: (input) => ({ kind: 'command', tool: 'Bash', command: input.command }),
  locations: (input, ctx) => readPathsOfCommand(input.command, commandSpecsFor(process.platform)).map((target) => ({ path: resolveToolPath(ctx.cwd, target) })),
  execute: async (input, ctx) => {
    if (input.run_in_background === true) return startBackgroundJob(input, ctx);
    const marker = requireMarker(ctx);
    const nonce = randomBytes(16).toString('hex');
    const script = `${trapScript(nonce)}\n${input.command}`;
    const child = ctx.sandbox.spawn(
      {
        argv: [bashPathFor(ctx.env), '-c', script],
        cwd: ctx.session.cwd,
        env: bashEnvOf(ctx.env),
        markerFile: marker,
        ...(ctx.tmpDir === undefined ? {} : { tmpDir: ctx.tmpDir }),
      },
      ctx.sandboxPolicy,
      ctx.signal,
    );
    ctx.attachProcess({ pgid: child.pgid, startedAt: ctx.clock.now() });

    const capture = createCapture();
    const pump = pumpOutput([child.stdout, child.stderr], (_index, chunk) => capture.push(chunk));
    let exit: SandboxExit;
    const notes: string[] = [];
    try {
      exit = await child.exited;
      const holders = await findHolders(marker);
      if (holders.length > 0) {
        await reconcileProcessGroup({ pgid: child.pgid, marker });
        notes.push(`Terminated ${holders.length} process(es) that outlived the command.`);
      }
      await pump.settle();
    } finally {
      await pump.close();
    }
    const failure = pump.failure();
    if (failure !== undefined) throw failure.error;

    const extracted = extractCwd(capture.text(), nonce);
    let output = extracted.output.replace(/\n+$/, '');
    if (extracted.cwd !== undefined) {
      if (insideAny(extracted.cwd, canonicalDirectories(ctx.roots))) {
        ctx.session.cwd = extracted.cwd;
      } else {
        output += `${output === '' ? '' : '\n'}Shell cwd was reset to ${shownPath(ctx, ctx.session.cwd)}`;
      }
    }
    for (const note of notes) output += `${output === '' ? '' : '\n'}${note}`;
    if (exit.signal !== null) return { status: 'failed', output: `${output}${output === '' ? '' : '\n'}[terminated by ${exit.signal}]` };
    const exitCode = exit.code === null ? {} : { exitCode: exit.code };
    if (exit.code !== 0) return { status: 'failed', output: `${output}${output === '' ? '' : '\n'}[exit code ${exit.code}]`, ...exitCode };
    return { status: 'completed', output, ...exitCode };
  },
  reconcile: async (input, record, ctx) => {
    if (input.run_in_background === true) {
      const job = requireJobs(ctx).byCall(ctx.idemKey);
      if (job === undefined) return { outcome: 'not_applied', output: '' };
      return {
        outcome: 'already_applied',
        output: `Started background job ${job.id}. The call was interrupted after the job started, so ${describeJobStatus(job)}.`,
      };
    }
    const unreadable = ctx.earlierAttempt?.uninspectable ?? [];
    if (unreadable.length > 0) {
      const named = unreadable.map(({ pid, command }) => `${pid} (${command})`).join(', ');
      return {
        outcome: 'unknown',
        output: `Process ${named} could not be inspected, so it was left alone and may still be running from the interrupted command. The effect of the interrupted command is unknown; inspect the current state before retrying it.`,
      };
    }
    if (ctx.earlierAttempt?.stopped === true) return stoppedCommandResult();
    if (record.pgid !== undefined && ctx.processMarker !== undefined) {
      return reconcileProcessGroup({ pgid: record.pgid, marker: ctx.processMarker });
    }
    return {
      outcome: 'unknown',
      output: 'The interrupted command may or may not have started, and its effect is unknown; inspect the current state before retrying it.',
    };
  },
});
