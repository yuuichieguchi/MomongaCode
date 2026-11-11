import { StringDecoder } from 'node:string_decoder';
import { commandSpecsFor, readPathsOfCommand } from '@momonga/policy';
import { groupRecordOutcome, hostEntryProblem, normalizedHosts, reconcileProcessGroup, resolveToolPath, stoppedCommandResult } from '@momonga/foundation';
import type { NetworkRequest } from '@momonga/foundation';
import { defineTool, ToolExecutionError, ToolInputError } from '../types.ts';
import { USER_SHELL_HEAD_BYTES, USER_SHELL_TAIL_BYTES } from '@momonga/protocol';
import type { SandboxCommand, SandboxExit, SandboxedProcess } from '@momonga/sandbox';
import type { BackgroundJobs } from '../ports.ts';
import type { ReconcileContext, ToolContext, ToolResult } from '../types.ts';
import { createCapture, pumpOutput } from '../capture.ts';
import { requireSpawnMarker, settleFinishedCommand } from '../marker-settle.ts';
import { describeJobStatus } from './jobs.ts';
import { openGrantedNetwork } from './network-egress.ts';
import { canonicalDirectories, insideAny, shownPath } from './paths.ts';
import { resolveBashPath } from './shell.ts';
import type { ShellHost } from './shell.ts';

type BashInput = { command: string; timeout?: number; description?: string; run_in_background?: boolean; network?: NetworkRequest };

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
export const DEFAULT_BACKGROUND_TIMEOUT_MS = 1_800_000;
export const MAX_BACKGROUND_TIMEOUT_MS = 7_200_000;
const TITLE_CHARS = 80;
const CWD_NONCE_BYTES = 16;
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

const bashPathFor = (shellHost: ShellHost, env: Readonly<Record<string, string>>): Promise<string> => resolveBashPath(shellHost.platform, { isExecutable: shellHost.isExecutable, env });

const bashEnvOf = (env: Readonly<Record<string, string>>): Record<string, string> => ({ ...env, CDPATH: '', GIT_TERMINAL_PROMPT: '0', PAGER: 'cat', GIT_PAGER: 'cat' });

const networkRequestOf = (network: NetworkRequest): NetworkRequest => {
  if (network === 'open') return network;
  for (const entry of network.hosts) {
    const problem = hostEntryProblem(entry);
    if (problem !== undefined) throw new ToolInputError(`network.hosts: ${problem}`);
  }
  return { hosts: normalizedHosts(network.hosts) };
};

const requireJobs = (ctx: ReconcileContext): BackgroundJobs => {
  if (ctx.jobs === undefined) throw new ToolExecutionError('Background jobs are not available in this runtime');
  return ctx.jobs;
};

const startBackgroundJob = async (input: BashInput, ctx: ToolContext): Promise<ToolResult> => {
  const jobs = requireJobs(ctx);
  const bash = await bashPathFor(ctx.shellHost, ctx.env);
  const network = await openGrantedNetwork(ctx);
  let jobId: string;
  try {
    ({ jobId } = await jobs.start({
      runId: ctx.runId,
      callKey: ctx.idemKey,
      callId: ctx.callId,
      command: input.command,
      timeoutMs: input.timeout ?? DEFAULT_BACKGROUND_TIMEOUT_MS,
      spawn: async (markerFile, signal, markerFd) => {
        const child = await ctx.sandbox.spawn(
          {
            argv: [bash, '-c', input.command],
            cwd: ctx.session.cwd,
            env: bashEnvOf(network.env),
            markerFile,
            ...(ctx.tmpDir === undefined ? {} : { tmpDir: ctx.tmpDir }),
          },
          network.sandboxPolicy,
          signal,
          markerFd === undefined ? {} : { markerFd },
        );
        return {
          ...child,
          exited: child.exited.finally(async () => {
            await network.settle();
          }),
        };
      },
    }));
  } catch (error) {
    await network.settle();
    throw error;
  }
  return {
    status: 'completed',
    output: `Started background job ${jobId}. Read its output with BashOutput (bash_id ${jobId}) and stop it with KillBash (shell_id ${jobId}).`,
    detached: true,
  };
};

export const shellCommandSubject = (command: string): { kind: 'command'; tool: string; command: string } => ({ kind: 'command', tool: 'Bash', command });

export const bashTool = defineTool<BashInput>({
  name: 'Bash',
  description: `Runs a shell command with /bin/bash inside a sandbox, in the current working directory. Output combines stdout and stderr. A cd that stays inside the workspace persists to later calls. timeout is in milliseconds (default ${DEFAULT_TIMEOUT_MS}, maximum ${MAX_TIMEOUT_MS}). No process started by the command outlives it. With run_in_background the command starts as a background job and the call returns its job id at once; read its output with BashOutput and stop it with KillBash. For a background job timeout is the time the job may run (default ${DEFAULT_BACKGROUND_TIMEOUT_MS}, maximum ${MAX_BACKGROUND_TIMEOUT_MS}); a job ends with its command, with KillBash, at its time limit, or when MomongaCode stops. The sandbox has no network: a command that needs it sets network to {"hosts": ["name", ...]} to reach only those hosts through a filtering proxy (HTTP and HTTPS; a program that ignores the proxy variables stays without network), or to "open" for unrestricted access. Either asks the person before the command runs, so name the fewest hosts that do the work.`,
  conciseDescription: `Runs a bash command in a sandbox in the working directory; output is stdout and stderr. timeout is in milliseconds (default ${DEFAULT_TIMEOUT_MS}, maximum ${MAX_TIMEOUT_MS}). With run_in_background it returns a job id; use BashOutput and KillBash. A background job's timeout defaults to ${DEFAULT_BACKGROUND_TIMEOUT_MS}, maximum ${MAX_BACKGROUND_TIMEOUT_MS}. The sandbox has no network; set network to {"hosts": ["name", ...]} (those hosts only, through a proxy for HTTP and HTTPS) or "open" when the command needs it; either asks the person.`,
  conciseParameterDescriptions: {
    command: 'Command to run',
    timeout: 'Timeout in milliseconds',
    description: 'What the command does',
    run_in_background: 'Run as a background job and return its job id',
    network: 'Network the command needs; absent means none',
  },
  kind: 'execute',
  sideEffect: 'exec',
  subjectKind: 'command',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', minLength: 1, description: 'The command to run' },
      timeout: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_BACKGROUND_TIMEOUT_MS,
        description: `Timeout in milliseconds. Maximum ${MAX_TIMEOUT_MS}; with run_in_background maximum ${MAX_BACKGROUND_TIMEOUT_MS}`,
      },
      description: { type: 'string', description: 'Short description of what the command does' },
      run_in_background: { type: 'boolean', description: 'Run the command as a background job and return its job id immediately' },
      network: {
        anyOf: [
          { enum: ['open'] },
          { type: 'object', properties: { hosts: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 } }, required: ['hosts'], additionalProperties: false },
        ],
        description: 'Network access the command needs. Absent: none. {"hosts": ["registry.example.org", "example.org:443"]}: only those hosts (a name or an IP address, optionally with :port), through a proxy. "open": unrestricted. The person is asked to approve either',
      },
    },
    required: ['command'],
    additionalProperties: false,
  },
  timeoutMs: (input) => (input.run_in_background === true ? DEFAULT_TIMEOUT_MS : (input.timeout ?? DEFAULT_TIMEOUT_MS)),
  prepare: async (input) => {
    if (input.run_in_background !== true && input.timeout !== undefined && input.timeout > MAX_TIMEOUT_MS) {
      throw new ToolInputError(`timeout ${input.timeout} exceeds the maximum of ${MAX_TIMEOUT_MS} ms for a foreground command; use run_in_background for a longer one (maximum ${MAX_BACKGROUND_TIMEOUT_MS} ms)`);
    }
    return {};
  },
  title: (input) => input.description ?? input.command.slice(0, TITLE_CHARS),
  subject: (input) => ({ ...shellCommandSubject(input.command), ...(input.network === undefined ? {} : { network: networkRequestOf(input.network) }) }),
  locations: (input, ctx) => readPathsOfCommand(input.command, commandSpecsFor(process.platform)).map((target) => ({ path: resolveToolPath(ctx.cwd, target) })),
  execute: async (input, ctx) => {
    if (input.run_in_background === true) return startBackgroundJob(input, ctx);
    const { file: marker, fd: markerFd, settle } = await requireSpawnMarker(ctx, 'Bash');
    const nonce = ctx.random.hex(CWD_NONCE_BYTES);
    const script = `${trapScript(nonce)}\n${input.command}`;
    const network = await openGrantedNetwork(ctx);
    let child: SandboxedProcess;
    try {
      child = await ctx.sandbox.spawn(
        {
          argv: [await bashPathFor(ctx.shellHost, ctx.env), '-c', script],
          cwd: ctx.session.cwd,
          env: bashEnvOf(network.env),
          markerFile: marker,
          ...(ctx.tmpDir === undefined ? {} : { tmpDir: ctx.tmpDir }),
        },
        network.sandboxPolicy,
        ctx.signal,
        { markerFd },
      );
    } catch (error) {
      await network.settle();
      throw error;
    }
    const attached = groupRecordOutcome(ctx.attachProcess({ pgid: child.pgid, startedAt: ctx.clock.now() }), marker);

    const capture = createCapture();
    const pump = pumpOutput([child.stdout, child.stderr], (_index, chunk) => capture.push(chunk), ctx.shellHost.child);
    let exit: SandboxExit;
    const notes: string[] = [];
    let refusals: string[];
    try {
      let groupNotice: string | undefined;
      [exit, groupNotice] = await Promise.all([child.exited, attached]);
      if (groupNotice !== undefined) notes.push(groupNotice);
      notes.push(...(await settleFinishedCommand(settle, { pgid: child.pgid, exit, signal: ctx.signal })));
      await pump.settle();
    } finally {
      await pump.close();
      refusals = await network.settle();
    }
    notes.push(...refusals);
    const failure = pump.failure();
    if (failure !== undefined) throw failure.error;

    const extracted = extractCwd(capture.text(), nonce);
    let output = extracted.output.replace(/\n+$/, '');
    if (extracted.cwd !== undefined) {
      if (await insideAny(extracted.cwd, await canonicalDirectories(ctx.roots, ctx.paths), ctx.paths)) {
        ctx.session.cwd = extracted.cwd;
      } else {
        output += `${output === '' ? '' : '\n'}Shell cwd was reset to ${await shownPath(ctx, ctx.session.cwd)}`;
      }
    } else {
      output += `${output === '' ? '' : '\n'}Shell cwd could not be determined and stays at ${await shownPath(ctx, ctx.session.cwd)}`;
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
    if (ctx.earlierAttempt?.stopped === true) return stoppedCommandResult();
    if (record.pgid !== undefined && ctx.processMarker !== undefined) {
      return reconcileProcessGroup({ pgid: record.pgid, marker: ctx.processMarker }, { signal: ctx.signal });
    }
    return {
      outcome: 'unknown',
      output: 'The interrupted command may or may not have started, and its effect is unknown; inspect the current state before retrying it.',
    };
  },
});

export type UserCommandHost = {
  command: string;
  cwd: string;
  env: Readonly<Record<string, string>>;
  shellHost: ShellHost;
  signal: AbortSignal;
  refusal(command: string): Promise<string | undefined>;
  spawn(command: SandboxCommand, signal: AbortSignal): SandboxedProcess | Promise<SandboxedProcess>;
  onOutput(text: string): void;
};

export type UserCommandOutcome = { kind: 'refused'; reason: string } | { kind: 'ran'; exitCode: number | null; output: string };

export const runUserCommand = async (host: UserCommandHost): Promise<UserCommandOutcome> => {
  const reason = await host.refusal(host.command);
  if (reason !== undefined) return { kind: 'refused', reason };
  const child = await host.spawn({ argv: [await bashPathFor(host.shellHost, host.env), '-c', host.command], cwd: host.cwd, env: bashEnvOf(host.env) }, host.signal);
  const capture = createCapture(USER_SHELL_HEAD_BYTES, USER_SHELL_TAIL_BYTES);
  const stdout = new StringDecoder('utf8');
  const stderr = new StringDecoder('utf8');
  const pump = pumpOutput([child.stdout, child.stderr], (index, chunk) => {
    capture.push(chunk);
    const text = (index === 0 ? stdout : stderr).write(chunk);
    if (text !== '') host.onOutput(text);
  }, host.shellHost.child);
  let exit: SandboxExit;
  try {
    exit = await child.exited;
    await pump.settle();
  } finally {
    await pump.close();
  }
  const failure = pump.failure();
  if (failure !== undefined) throw failure.error;
  const output = capture.text().replace(/\n+$/, '');
  return { kind: 'ran', exitCode: exit.code, output: exit.signal === null ? output : `${output}${output === '' ? '' : '\n'}[terminated by ${exit.signal}]` };
};
