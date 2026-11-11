import path from 'node:path';
import { canonicalJson, groupRecordOutcome, sha256Hex } from '@momonga/foundation';
import type { HelperSelf, NetworkScope, OutboundNetwork, ProcessInspector } from '@momonga/foundation';
import type { Sandbox, SandboxPolicy } from '@momonga/sandbox';
import { openGrantedNetwork } from '../builtins/network-egress.ts';
import type { GrantedNetwork } from '../builtins/network-egress.ts';
import type { ShellHost } from '../builtins/shell.ts';
import { createCapture, pumpOutput } from '../capture.ts';
import type { MarkerOwners } from '../marker-owners.ts';
import { requireSpawnMarker, settleFinishedCommand } from '../marker-settle.ts';
import { runSandboxedCommand } from '../sandboxed-command.ts';
import { ToolExecutionError } from '../types.ts';
import { gitProxyEnvironment } from '../read-only-call.ts';
import type { ProbeContext, ToolContext } from '../types.ts';
import { openGitCredentialChannel } from './git-credential.ts';
import type { GitCredentialChannel, GitOriginCredential } from './git-credential.ts';

export type ArgvResult = { exitCode: number; stdout: string; stderr: string };

export type RenderedNetwork = 'none' | { destinations: readonly string[] };

export type ArgvOptions = {
  cwd: string;
  env: Readonly<Record<string, string>>;
  signal: AbortSignal;
  network: RenderedNetwork;
  context: ProbeContext | ToolContext;
  effect: boolean;
  credentials?: readonly GitOriginCredential[];
  stdin?: string;
};

export type ArgvRunner = (argv: readonly string[], options: ArgvOptions) => Promise<ArgvResult>;

export type ReconcileSandbox = { sandbox: Sandbox; sandboxPolicy: SandboxPolicy; release(): void };

export type SandboxedRunnerPorts = {
  reconcileSandbox(context: ProbeContext): Promise<ReconcileSandbox>;
  shellHost: ShellHost;
  outboundNetwork(signal: AbortSignal): Promise<OutboundNetwork>;
  markerDir: string;
  credentialRoot: string;
  credentialHelper?: HelperSelf;
  owners?: MarkerOwners;
  inspector: ProcessInspector;
};

const LOCAL_DESTINATION = /^(file:\/\/|\/)/;
const PROXIED_SCHEMES: readonly string[] = ['http:', 'https:'];
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export const networkScopeOfDestinations = (destinations: readonly string[], program: string): NetworkScope => {
  const hosts: string[] = [];
  for (const destination of destinations) {
    if (LOCAL_DESTINATION.test(destination)) continue;
    const url = SCHEME.test(destination) ? new URL(destination) : undefined;
    if (url === undefined || !PROXIED_SCHEMES.includes(url.protocol)) {
      throw new ToolExecutionError(`${program} was not run: ${destination} is not reached over HTTP or HTTPS, and the sandbox carries only those to a named host`);
    }
    hosts.push(url.host);
  }
  return hosts.length === 0 ? { kind: 'none' } : { kind: 'hosts', hosts: [...new Set(hosts)] };
};

type Supplied = { env: Readonly<Record<string, string>>; sandboxPolicy: SandboxPolicy; redact(text: string): string; close(): Promise<void> };

const supplyCredentials = async (ports: SandboxedRunnerPorts, options: ArgvOptions, granted: { env: Readonly<Record<string, string>>; sandboxPolicy: SandboxPolicy }): Promise<Supplied> => {
  const credentials = options.credentials ?? [];
  if (credentials.length === 0) return { ...granted, redact: (text) => text, close: async () => undefined };
  if (ports.credentialHelper === undefined) {
    throw new ToolExecutionError('git was not run: this process was started without the executable that answers the credential prompt of git, so the credential of the forge cannot be given. Start momonga through its own command.');
  }
  const channel: GitCredentialChannel = await openGitCredentialChannel(credentials, { root: ports.credentialRoot, random: options.context.random, files: options.context.files, helper: ports.credentialHelper });
  return {
    env: channel.environment(granted.env),
    sandboxPolicy: { ...granted.sandboxPolicy, unixSocketAllow: [...(granted.sandboxPolicy.unixSocketAllow ?? []), channel.directory] },
    redact: channel.redact,
    close: channel.close,
  };
};

const startsEffects = (context: ProbeContext | ToolContext): context is ToolContext => 'spawnMarker' in context && context.spawnMarker !== undefined;

const sandboxOf = (ports: SandboxedRunnerPorts, context: ProbeContext): Promise<ReconcileSandbox> | ReconcileSandbox =>
  context.sandbox === undefined || context.sandboxPolicy === undefined ? ports.reconcileSandbox(context) : { sandbox: context.sandbox, sandboxPolicy: context.sandboxPolicy, release: () => undefined };

const destinationsOf = (network: RenderedNetwork): readonly string[] => (network === 'none' ? [] : network.destinations);

const grantNetwork = async (options: ArgvOptions, argv: readonly string[], granting: Pick<ToolContext, 'outboundNetwork' | 'sandboxPolicy'>): Promise<GrantedNetwork> => {
  const destinations = destinationsOf(options.network);
  const granted = await openGrantedNetwork({ network: networkScopeOfDestinations(destinations, programOf(argv)), outboundNetwork: granting.outboundNetwork, sandboxPolicy: granting.sandboxPolicy, env: options.env });
  return granted.proxy === undefined ? granted : { ...granted, env: gitProxyEnvironment(granted.env, granted.proxy, destinations) };
};

const programOf = (argv: readonly string[]): string => argv.slice(0, 2).join(' ');

const runProbe = async (ports: SandboxedRunnerPorts, argv: readonly string[], options: ArgvOptions, sequence: number): Promise<ArgvResult> => {
  const { context } = options;
  const held: ReconcileSandbox = await sandboxOf(ports, context);
  let network: GrantedNetwork;
  try {
    network = await grantNetwork(options, argv, { outboundNetwork: await ports.outboundNetwork(context.signal), sandboxPolicy: held.sandboxPolicy });
  } catch (error) {
    held.release();
    throw error;
  }
  let supplied: Supplied | undefined;
  try {
    supplied = await supplyCredentials(ports, options, network);
    const { redact } = supplied;
    const result = await runSandboxedCommand({
      argv,
      sandbox: held.sandbox,
      sandboxPolicy: supplied.sandboxPolicy,
      env: supplied.env,
      shellHost: ports.shellHost,
      cwd: options.cwd,
      markerFile: path.join(ports.markerDir, `operation-${sha256Hex(canonicalJson([context.idemKey, sequence]))}`),
      clock: context.clock,
      signal: options.signal,
      timeoutMs: Math.max(0, context.deadlineAt - context.clock.now()),
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      ...(context.tmpDir === undefined ? {} : { tmpDir: context.tmpDir }),
      inspector: ports.inspector,
      ...(ports.owners === undefined ? {} : { owners: ports.owners }),
    });
    if (result.kind === 'exited') return { exitCode: result.exitCode, stdout: redact(result.stdout), stderr: redact(result.stderr) };
    if (result.kind === 'signaled') return { exitCode: 1, stdout: redact(result.stdout), stderr: `${redact(result.stderr)}\n[terminated by ${result.signal}]` };
    if (result.kind === 'spawn_error') throw new ToolExecutionError(`${programOf(argv)} could not be started: ${result.message}`);
    throw new ToolExecutionError(`${programOf(argv)} was cancelled or ran out of time`);
  } finally {
    await supplied?.close();
    await network.settle();
    held.release();
  }
};

const runEffect = async (ports: SandboxedRunnerPorts, argv: readonly string[], options: ArgvOptions, context: ToolContext): Promise<ArgvResult> => {
  const { file, fd, settle } = await requireSpawnMarker(context, programOf(argv));
  const network = await grantNetwork(options, argv, context);
  let supplied: Supplied | undefined;
  try {
    supplied = await supplyCredentials(ports, options, network);
    const { redact } = supplied;
    const child = await context.sandbox.spawn(
      { argv: [...argv], cwd: options.cwd, env: { ...supplied.env }, markerFile: file, ...(context.tmpDir === undefined ? {} : { tmpDir: context.tmpDir }) },
      supplied.sandboxPolicy,
      options.signal,
      { markerFd: fd },
    );
    const attached = groupRecordOutcome(context.attachProcess({ pgid: child.pgid, startedAt: context.clock.now() }), file);
    const captures = [createCapture(), createCapture()] as const;
    const pump = pumpOutput([child.stdout, child.stderr], (index, chunk) => captures[index === 0 ? 0 : 1].push(chunk), ports.shellHost.child);
    try {
      const [exit] = await Promise.all([child.exited, attached]);
      await settleFinishedCommand(settle, { pgid: child.pgid, exit, signal: options.signal });
      await pump.settle();
      const failure = pump.failure();
      if (failure !== undefined) throw failure.error;
      return { exitCode: exit.code ?? 1, stdout: redact(captures[0].text()), stderr: redact(captures[1].text()) };
    } finally {
      await pump.close();
    }
  } finally {
    await supplied?.close();
    await network.settle();
  }
};

export const createSandboxedArgvRunner = (ports: SandboxedRunnerPorts): ArgvRunner => {
  let sequence = 0;
  return (argv, options) => {
    if (options.effect && startsEffects(options.context)) return runEffect(ports, argv, options, options.context);
    sequence += 1;
    return runProbe(ports, argv, options, sequence);
  };
};
