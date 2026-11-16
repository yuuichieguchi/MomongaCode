import { StringDecoder } from 'node:string_decoder';
import { commandSpecsFor, readPathsOfCommand } from '@momonga/policy';
import { groupRecordOutcome, hostEntryProblem, normalizedHosts, reconcileProcessGroup, resolveToolPath, stoppedCommandResult } from '@momonga/foundation';
import type { NetworkRequest, SandboxNetworkSetting } from '@momonga/foundation';
import { SANDBOX_NETWORK_SCOPES } from '@momonga/sandbox';
import { defineTool, ToolExecutionError, ToolInputError } from '../types.ts';
import type { AnyTool, BashLimits } from '../types.ts';
import { USER_SHELL_HEAD_BYTES, USER_SHELL_TAIL_BYTES } from '@momonga/protocol';
import { STOP_NOT_CONFIRMED_NOTE } from '@momonga/sandbox';
import type { Sandbox, SandboxCommand, SandboxExit, SandboxedProcess } from '@momonga/sandbox';
import type { BackgroundJobs } from '../ports.ts';
import type { ReconcileContext, ToolContext, ToolResult } from '../types.ts';
import { createCapture, pumpOutput } from '../capture.ts';
import type { Drained } from '../capture.ts';
import { requireSpawnMarker, settleFinishedCommand } from '../marker-settle.ts';
import { describeJobStatus } from './jobs.ts';
import { openGrantedNetwork } from './network-egress.ts';
import { canonicalDirectories, insideAny, shownPath } from './paths.ts';
import { resolveBashPath } from './shell.ts';
import type { ShellHost } from './shell.ts';

type BashInput = { command: string; timeout?: number; description?: string; run_in_background?: boolean; network?: NetworkRequest };

const CWD_NONCE_BYTES = 16;
const trapScript = (nonce: string): string =>
  `trap 'status=$?; printf "\\n__MOMONGA_CWD_${nonce}__=%s\\n" "$(pwd -P)"; exit $status' EXIT`;

const withoutCwdRecord = (nonce: string, sink: (chunk: Buffer) => void): { push(chunk: Buffer): void; flush(): void } => {
  const record = Buffer.from(`__MOMONGA_CWD_${nonce}__=`);
  let held = Buffer.alloc(0);
  let dropping = false;
  const heldFrom = (data: Buffer): number => {
    for (let start = Math.max(0, data.length - record.length + 1); start < data.length; start += 1) {
      if (record.subarray(0, data.length - start).equals(data.subarray(start))) return start;
    }
    return data.length;
  };
  const push = (chunk: Buffer): void => {
    let data = Buffer.concat([held, chunk]);
    held = Buffer.alloc(0);
    for (;;) {
      if (dropping) {
        const end = data.indexOf(0x0a);
        if (end === -1) return;
        dropping = false;
        data = data.subarray(end + 1);
        continue;
      }
      const found = data.indexOf(record);
      if (found !== -1) {
        if (found > 0) sink(data.subarray(0, found));
        dropping = true;
        data = data.subarray(found + record.length);
        continue;
      }
      const keep = heldFrom(data);
      if (keep > 0) sink(data.subarray(0, keep));
      held = Buffer.from(data.subarray(keep));
      return;
    }
  };
  return {
    push,
    flush: () => {
      if (held.length > 0 && !dropping) sink(held);
      held = Buffer.alloc(0);
    },
  };
};

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

export const bashEnvOf = (env: Readonly<Record<string, string>>): Record<string, string> => ({ ...env, CDPATH: '', GIT_TERMINAL_PROMPT: '0', PAGER: 'cat', GIT_PAGER: 'cat' });

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

const withLateChunk = async function* (stream: AsyncIterable<Uint8Array>, late: Promise<Uint8Array | undefined>): AsyncGenerator<Uint8Array> {
  const chunks = stream[Symbol.asyncIterator]();
  let awaited: Promise<{ late: Uint8Array | undefined }> | undefined = late.then((chunk) => ({ late: chunk }));
  let next = chunks.next();
  for (;;) {
    const first = await (awaited === undefined ? next : Promise.race([next, awaited]));
    if ('late' in first) {
      awaited = undefined;
      if (first.late !== undefined) yield first.late;
    } else if (first.done === true) {
      break;
    } else {
      yield first.value;
      next = chunks.next();
    }
  }
  if (awaited === undefined) return;
  const last = (await awaited).late;
  if (last !== undefined) yield last;
};

const clamped = (requested: number, maximum: number): { ms: number; note: string | undefined } =>
  requested > maximum ? { ms: maximum, note: `timeout reduced to the configured maximum of ${maximum} ms` } : { ms: requested, note: undefined };

const foregroundTimeoutOf = (input: BashInput, limits: BashLimits): { ms: number; note: string | undefined } => clamped(input.timeout ?? limits.defaultTimeoutMs, limits.maxTimeoutMs);

const backgroundTimeoutOf = (input: BashInput, limits: BashLimits): { ms: number; note: string | undefined } => clamped(input.timeout ?? limits.backgroundTimeoutMs, limits.maxBackgroundTimeoutMs);

const withLine = (output: string, line: string | undefined): string => (line === undefined ? output : `${output}${output === '' ? '' : '\n'}${line}`);

const signalled = (signal: AbortSignal): { fired: Promise<void>; dispose(): void } => {
  let onAbort: (() => void) | undefined;
  const fired = new Promise<void>((resolve) => {
    onAbort = () => resolve();
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  return { fired, dispose: () => onAbort !== undefined && signal.removeEventListener('abort', onAbort) };
};

const movedText = (jobId: string, timeoutMs: number): string =>
  `The command did not complete within its timeout of ${timeoutMs} ms and was moved to the background as ${jobId}. Read its output with BashOutput (bash_id ${jobId}) and stop it with KillBash (shell_id ${jobId}).`;

const startBackgroundJob = async (input: BashInput, ctx: ToolContext): Promise<ToolResult> => {
  const jobs = requireJobs(ctx);
  const timeout = backgroundTimeoutOf(input, ctx.limits.bash);
  const bash = await bashPathFor(ctx.shellHost, ctx.env);
  const network = await openGrantedNetwork(ctx);
  let jobId: string;
  try {
    ({ jobId } = await jobs.start({
      runId: ctx.runId,
      callKey: ctx.idemKey,
      callId: ctx.callId,
      command: input.command,
      timeoutMs: timeout.ms,
      drainIdleMs: ctx.limits.bash.drainIdleMs,
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
        const settled = child.exited.then(
          async (exit) => ({ exit, refusals: await network.settle() }),
          async (error: unknown) => {
            await network.settle();
            throw error;
          },
        );
        const refusalText = settled.then(
          ({ refusals }) => (refusals.length === 0 ? undefined : Buffer.from(`${refusals.join('\n')}\n`)),
          () => undefined,
        );
        return { ...child, stderr: withLateChunk(child.stderr, refusalText), exited: settled.then(({ exit }) => exit) };
      },
    }));
  } catch (error) {
    await network.settle();
    throw error;
  }
  return {
    status: 'completed',
    output: withLine(`Started background job ${jobId}. Read its output with BashOutput (bash_id ${jobId}) and stop it with KillBash (shell_id ${jobId}).`, timeout.note),
    detached: true,
  };
};

export const shellCommandSubject = (command: string): { kind: 'command'; tool: string; command: string } => ({ kind: 'command', tool: 'Bash', command });

export type OfferedBash = { kind: 'resolved'; path: string } | { kind: 'missing'; reason: string };

export type BuiltinToolOffer = { sandbox: Sandbox['kind']; sandboxNetwork: SandboxNetworkSetting; bash: OfferedBash };

const shellNameOf = (bash: OfferedBash): string => (bash.kind === 'resolved' ? bash.path : `bash, which this machine does not have (${bash.reason}), so every call fails until it is installed,`);

const placeOf = (offer: BuiltinToolOffer): string =>
  keepsCommandsOffTheNetwork(offer.sandbox) ? 'inside a sandbox' : 'with no sandbox (the command has the access to files and the network of the person who runs MomongaCode)';

const BASH_DESCRIPTION_REST = `Output combines stdout and stderr. A cd that stays inside the workspace persists to later calls. timeout is in milliseconds; its default and its maximum are the person's settings tools.bash.defaultTimeoutMs and tools.bash.maxTimeoutMs (120000 and 600000 unless changed), and a larger value is reduced to the maximum. No process started by the command outlives it, except that a command that exceeds its timeout is moved to the background (unless the setting tools.bash.onTimeout is kill). With run_in_background the command starts as a background job and the call returns its job id at once; read its output with BashOutput and stop it with KillBash. For a background job timeout is the time the job may run (tools.bash.backgroundTimeoutMs and tools.bash.maxBackgroundTimeoutMs, 1800000 and 7200000 unless changed); a job ends with its command, with KillBash, at its time limit, or when MomongaCode stops.`;

const BASH_CONCISE_HEAD = `Runs a bash command in a sandbox in the working directory; output is stdout and stderr. timeout is in milliseconds, default and maximum from the settings tools.bash (120000 and 600000 unless changed); a command past its timeout moves to the background. With run_in_background it returns a job id; use BashOutput and KillBash.`;

const conciseHeadOf = (offer: BuiltinToolOffer): string => (keepsCommandsOffTheNetwork(offer.sandbox) ? BASH_CONCISE_HEAD : BASH_CONCISE_HEAD.replace('in a sandbox', `with ${shellNameOf(offer.bash)} and no sandbox`));

const keepsCommandsOffTheNetwork = (sandbox: Sandbox['kind']): boolean => SANDBOX_NETWORK_SCOPES[sandbox].includes('none');

const takesHosts = (sandbox: Sandbox['kind']): boolean => SANDBOX_NETWORK_SCOPES[sandbox].includes('hosts');

const settingSentenceOf = (offer: BuiltinToolOffer): string => {
  switch (offer.sandboxNetwork) {
    case 'ask':
      return takesHosts(offer.sandbox) ? 'Either asks the person before the command runs, so name the fewest hosts that do the work.' : 'This asks the person before the command runs.';
    case 'allow':
      return 'The setting sandboxNetwork is allow, so a command that sets network runs without approval for it.';
    case 'deny':
      return 'The setting sandboxNetwork is deny, so a command that sets network is refused.';
  }
};

const networkSentenceOf = (offer: BuiltinToolOffer): string => {
  if (!keepsCommandsOffTheNetwork(offer.sandbox)) {
    return `Without a sandbox nothing keeps the command off the network, and a list of hosts cannot be kept: a command that needs the network sets network to "open". ${settingSentenceOf(offer)}`;
  }
  if (takesHosts(offer.sandbox)) {
    return `The sandbox has no network: a command that needs it sets network to {"hosts": ["name", ...]} to reach only those hosts through a filtering proxy (HTTP and HTTPS; a program that ignores the proxy variables stays without network), or to "open" for unrestricted access. ${settingSentenceOf(offer)}`;
  }
  return `The sandbox has no network: a command that needs it sets network to "open" for unrestricted access. ${settingSentenceOf(offer)}`;
};

const conciseNetworkOf = (offer: BuiltinToolOffer): string => {
  if (!keepsCommandsOffTheNetwork(offer.sandbox)) return `Set network to "open" when the command needs it. ${settingSentenceOf(offer)}`;
  if (takesHosts(offer.sandbox)) return `The sandbox has no network; set network to {"hosts": ["name", ...]} (those hosts only, through a proxy for HTTP and HTTPS) or "open" when the command needs it. ${settingSentenceOf(offer)}`;
  return `The sandbox has no network; set network to "open" when the command needs it. ${settingSentenceOf(offer)}`;
};

const networkParameterOf = (offer: BuiltinToolOffer): string => {
  if (!keepsCommandsOffTheNetwork(offer.sandbox)) return `Network access the command needs. "open": unrestricted, which a command without a sandbox has in any case; a list of hosts cannot be kept without a sandbox. ${settingSentenceOf(offer)}`;
  const hosts = takesHosts(offer.sandbox) ? ' {"hosts": ["registry.example.org", "example.org:443"]}: only those hosts (a name or an IP address, optionally with :port), through a proxy.' : '';
  return `Network access the command needs. Absent: none.${hosts} "open": unrestricted. ${settingSentenceOf(offer)}`;
};

export const bashDescriptionOf = (offer: BuiltinToolOffer): { description: string; conciseDescription: string } => ({
  description: `Runs a shell command with ${shellNameOf(offer.bash)} ${placeOf(offer)}, in the current working directory. ${BASH_DESCRIPTION_REST} ${networkSentenceOf(offer)}`,
  conciseDescription: `${conciseHeadOf(offer)} ${conciseNetworkOf(offer)}`,
});

export const bashToolFor = (offer: BuiltinToolOffer): AnyTool => defineTool<BashInput>({
  name: 'Bash',
  ...bashDescriptionOf(offer),
  conciseParameterDescriptions: {
    command: 'Command to run',
    timeout: 'Timeout in milliseconds',
    description: 'What the command does',
    run_in_background: 'Run as a background job and return its job id',
    network: keepsCommandsOffTheNetwork(offer.sandbox) ? 'Network the command needs; absent means none' : 'Network the command needs; without a sandbox it has the network in any case',
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
        description: 'Timeout in milliseconds; a value above the configured maximum is reduced to it',
      },
      description: { type: 'string', description: 'Short description of what the command does' },
      run_in_background: { type: 'boolean', description: 'Run the command as a background job and return its job id immediately' },
      network: {
        anyOf: [
          { enum: ['open'] },
          { type: 'object', properties: { hosts: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 } }, required: ['hosts'], additionalProperties: false },
        ],
        description: networkParameterOf(offer),
      },
    },
    required: ['command'],
    additionalProperties: false,
  },
  timeoutMs: (input, limits) => (input.run_in_background === true ? limits.bash.defaultTimeoutMs : foregroundTimeoutOf(input, limits.bash).ms),
  expiry: 'detach',
  title: (input) => input.command,
  approval: async (input) => ({ effect: input.command, ...(input.description === undefined ? {} : { claim: input.description }) }),
  subject: (input) => ({ ...shellCommandSubject(input.command), ...(input.network === undefined ? {} : { network: networkRequestOf(input.network) }) }),
  locations: (input, ctx) => readPathsOfCommand(input.command, commandSpecsFor(process.platform)).map((target) => ({ path: resolveToolPath(ctx.cwd, target) })),
  execute: async (input, ctx) => {
    if (input.run_in_background === true) {
      const started = startBackgroundJob(input, ctx);
      const expiry = signalled(ctx.expired);
      try {
        await Promise.race([started, expiry.fired.then(() => ctx.stopForTimeout())]);
      } finally {
        expiry.dispose();
      }
      return await started;
    }
    const timeout = foregroundTimeoutOf(input, ctx.limits.bash);
    const { file: marker, fd: markerFd, mode: markerMode, settle } = await requireSpawnMarker(ctx, 'Bash');
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
    let forward: ((chunk: Buffer) => void) | undefined;
    let flushForwarded: (() => void) | undefined;
    const pump = pumpOutput(
      [child.stdout, child.stderr],
      (_index, chunk) => {
        if (forward === undefined) capture.push(chunk);
        else forward(chunk);
      },
      ctx.shellHost.child,
    );
    const finished = Promise.all([child.exited, attached]);
    const expiry = signalled(ctx.expired);
    let expired: boolean;
    try {
      expired = await Promise.race([finished.then(() => false), expiry.fired.then(() => true)]);
    } finally {
      expiry.dispose();
    }
    if (expired) {
      const jobs = ctx.jobs;
      if (ctx.limits.bash.onTimeout === 'kill' || jobs === undefined) ctx.stopForTimeout();
      else {
        const groupNotice = await attached;
        const seen = withLine(capture.text().replace(/\n+$/, ''), groupNotice);
        try {
          const { jobId } = await jobs.adopt({
            runId: ctx.runId,
            callKey: ctx.idemKey,
            callId: ctx.callId,
            command: input.command,
            timeoutMs: ctx.limits.bash.backgroundTimeoutMs,
            drainIdleMs: ctx.limits.bash.drainIdleMs,
            process: {
              ...child,
              exited: child.exited.then(async (exit) => {
                const refusals = await network.settle();
                if (refusals.length > 0) forward?.(Buffer.from(`${refusals.join('\n')}\n`));
                return exit;
              }),
            },
            marker: { file: marker, mode: markerMode },
            output: {
              seen: Buffer.from(seen === '' ? '' : `${seen}\n`),
              follow: (sink) => {
                const filtered = withoutCwdRecord(nonce, sink);
                forward = filtered.push;
                flushForwarded = filtered.flush;
              },
              drainAfterExit: async (idleMs, owner) => {
                const drained = await pump.drainAfterExit(idleMs, owner);
                flushForwarded?.();
                return drained;
              },
              close: () => pump.close(),
              failure: () => pump.failure(),
            },
          });
          return { status: 'completed', output: withLine(withLine(seen, timeout.note), movedText(jobId, timeout.ms)), detached: true };
        } catch (error) {
          if (!(error instanceof ToolExecutionError)) throw error;
          ctx.stopForTimeout(error.message);
        }
      }
    }
    let exit: SandboxExit;
    const notes: string[] = [];
    let residue = false;
    let refusals: string[];
    try {
      let groupNotice: string | undefined;
      [exit, groupNotice] = await finished;
      if (groupNotice !== undefined) notes.push(groupNotice);
      if (exit.stop === 'not_confirmed') notes.push(STOP_NOT_CONFIRMED_NOTE);
      notes.push(...(await settleFinishedCommand(settle, { pgid: child.pgid, exit, signal: ctx.signal })));
      const drained = await pump.drainAfterExit(ctx.limits.bash.drainIdleMs, AbortSignal.any([ctx.signal, ctx.expired]));
      if (!drained.complete) {
        notes.push(drained.note);
        residue = true;
      }
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
    output = withLine(output, timeout.note);
    const exitCode = exit.code === null ? {} : { exitCode: exit.code };
    const incomplete = residue ? { outputIncomplete: 'residue' as const } : {};
    if (exit.signal !== null) return { status: 'failed', output: `${output}${output === '' ? '' : '\n'}[terminated by ${exit.signal}]`, ...incomplete };
    if (exit.code !== 0) return { status: 'failed', output: `${output}${output === '' ? '' : '\n'}[exit code ${exit.code}]`, ...exitCode, ...incomplete };
    return { status: 'completed', output, ...exitCode, ...incomplete };
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
    const promoted = ctx.jobs?.byCall(ctx.idemKey);
    if (promoted !== undefined) {
      return { outcome: 'unknown', output: `The command was being moved to the background as ${promoted.id} when the call was interrupted, so ${describeJobStatus(promoted)}.` };
    }
    if (ctx.earlierAttempt?.stopped === true) return stoppedCommandResult();
    if (record.pgid !== undefined && ctx.processMarker !== undefined) {
      return reconcileProcessGroup({ pgid: record.pgid, marker: ctx.processMarker }, { signal: ctx.signal, inspector: ctx.inspector });
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
  drainIdleMs: number;
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
  let drained: Drained;
  try {
    exit = await child.exited;
    drained = await pump.drainAfterExit(host.drainIdleMs, host.signal);
  } finally {
    await pump.close();
  }
  const failure = pump.failure();
  if (failure !== undefined) throw failure.error;
  const output = withLine(capture.text().replace(/\n+$/, ''), drained.complete ? undefined : drained.note);
  return { kind: 'ran', exitCode: exit.code, output: exit.signal === null ? output : `${output}${output === '' ? '' : '\n'}[terminated by ${exit.signal}]` };
};
