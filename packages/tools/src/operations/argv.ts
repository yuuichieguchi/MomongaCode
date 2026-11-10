import path from 'node:path';
import { canonicalJson, groupRecordOutcome, sha256Hex } from '@momonga/foundation';
import type { NetworkScope, ProcessInspector } from '@momonga/foundation';
import type { Sandbox, SandboxPolicy } from '@momonga/sandbox';
import { openGrantedNetwork } from '../builtins/network-egress.ts';
import type { ShellHost } from '../builtins/shell.ts';
import { createCapture, pumpOutput } from '../capture.ts';
import type { MarkerOwners } from '../marker-owners.ts';
import { requireSpawnMarker, settleFinishedCommand } from '../marker-settle.ts';
import { runSandboxedCommand } from '../sandboxed-command.ts';
import { ToolExecutionError } from '../types.ts';
import type { ReconcileContext, ToolContext } from '../types.ts';

export type ArgvResult = { exitCode: number; stdout: string; stderr: string };

export type RenderedNetwork = 'none' | { destinations: readonly string[] };

export type ArgvOptions = {
  cwd: string;
  env: Readonly<Record<string, string>>;
  signal: AbortSignal;
  network: RenderedNetwork;
  context: ReconcileContext | ToolContext;
  effect: boolean;
};

export type ArgvRunner = (argv: readonly string[], options: ArgvOptions) => Promise<ArgvResult>;

export type ReconcileSandbox = { sandbox: Sandbox; sandboxPolicy: SandboxPolicy; release(): void };

export type SandboxedRunnerPorts = {
  reconcileSandbox(context: ReconcileContext): Promise<ReconcileSandbox>;
  shellHost: ShellHost;
  markerDir: string;
  owners?: MarkerOwners;
  inspector?: ProcessInspector;
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

const isToolContext = (context: ReconcileContext | ToolContext): context is ToolContext => 'sandboxPolicy' in context;

const programOf = (argv: readonly string[]): string => argv.slice(0, 2).join(' ');

const runProbe = async (ports: SandboxedRunnerPorts, argv: readonly string[], options: ArgvOptions, sequence: number): Promise<ArgvResult> => {
  const { context } = options;
  const scope = networkScopeOfDestinations(options.network === 'none' ? [] : options.network.destinations, programOf(argv));
  const held: ReconcileSandbox = isToolContext(context) ? { sandbox: context.sandbox, sandboxPolicy: context.sandboxPolicy, release: () => undefined } : await ports.reconcileSandbox(context);
  let network: Awaited<ReturnType<typeof openGrantedNetwork>>;
  try {
    network = await openGrantedNetwork({ network: scope, sandboxPolicy: held.sandboxPolicy, env: options.env });
  } catch (error) {
    held.release();
    throw error;
  }
  try {
    const result = await runSandboxedCommand({
      argv,
      sandbox: held.sandbox,
      sandboxPolicy: network.sandboxPolicy,
      env: network.env,
      shellHost: ports.shellHost,
      cwd: options.cwd,
      markerFile: path.join(ports.markerDir, `operation-${sha256Hex(canonicalJson([context.idemKey, sequence]))}`),
      clock: context.clock,
      signal: options.signal,
      timeoutMs: Math.max(0, context.deadlineAt - context.clock.now()),
      ...(context.tmpDir === undefined ? {} : { tmpDir: context.tmpDir }),
      ...(ports.inspector === undefined ? {} : { inspector: ports.inspector }),
      ...(ports.owners === undefined ? {} : { owners: ports.owners }),
    });
    if (result.kind === 'exited') return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    if (result.kind === 'signaled') return { exitCode: 1, stdout: result.stdout, stderr: `${result.stderr}\n[terminated by ${result.signal}]` };
    if (result.kind === 'spawn_error') throw new ToolExecutionError(`${programOf(argv)} could not be started: ${result.message}`);
    throw new ToolExecutionError(`${programOf(argv)} was cancelled or ran out of time`);
  } finally {
    await network.settle();
    held.release();
  }
};

const runEffect = async (argv: readonly string[], options: ArgvOptions, context: ToolContext): Promise<ArgvResult> => {
  const { file, fd, settle } = await requireSpawnMarker(context, programOf(argv));
  const network = await openGrantedNetwork({ network: networkScopeOfDestinations(options.network === 'none' ? [] : options.network.destinations, programOf(argv)), sandboxPolicy: context.sandboxPolicy, env: options.env });
  try {
    const child = context.sandbox.spawn(
      { argv: [...argv], cwd: options.cwd, env: { ...network.env }, markerFile: file, ...(context.tmpDir === undefined ? {} : { tmpDir: context.tmpDir }) },
      network.sandboxPolicy,
      options.signal,
      { markerFd: fd },
    );
    const attached = groupRecordOutcome(context.attachProcess({ pgid: child.pgid, startedAt: context.clock.now() }), file);
    const captures = [createCapture(), createCapture()] as const;
    const pump = pumpOutput([child.stdout, child.stderr], (index, chunk) => captures[index === 0 ? 0 : 1].push(chunk));
    try {
      const [exit] = await Promise.all([child.exited, attached]);
      await settleFinishedCommand(settle, { pgid: child.pgid, exit, signal: options.signal });
      await pump.settle();
      const failure = pump.failure();
      if (failure !== undefined) throw failure.error;
      return { exitCode: exit.code ?? 1, stdout: captures[0].text(), stderr: captures[1].text() };
    } finally {
      await pump.close();
    }
  } finally {
    await network.settle();
  }
};

export const createSandboxedArgvRunner = (ports: SandboxedRunnerPorts): ArgvRunner => {
  let sequence = 0;
  return (argv, options) => {
    if (options.effect && isToolContext(options.context) && options.context.spawnMarker !== undefined) return runEffect(argv, options, options.context);
    sequence += 1;
    return runProbe(ports, argv, options, sequence);
  };
};
