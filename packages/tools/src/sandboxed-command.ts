import path from 'node:path';
import { UNMEASURED_CAPABILITY, canonicalJson, createMarker, defaultProcessInspector, groupRecordOutcome, recordMarkerGroup, sha256Hex } from '@momonga/foundation';
import type { Clock, ProcessGroupPort, ProcessInspector } from '@momonga/foundation';
import type { Sandbox, SandboxExit, SandboxPolicy } from '@momonga/sandbox';
import { createCapture, pumpOutput } from './capture.ts';
import { resolveBashPath } from './builtins/shell.ts';
import type { ShellHost } from './builtins/shell.ts';
import { createMarkerSettle, settleFinishedCommand } from './marker-settle.ts';
import type { MarkerOwners } from './marker-owners.ts';
import { cancellableTimer } from './timers.ts';

export type SandboxedCommandLine = { command: string } | { argv: readonly string[] };

export type SandboxedCommandRequest = SandboxedCommandLine & {
  sandbox: Sandbox;
  sandboxPolicy: SandboxPolicy;
  env: Readonly<Record<string, string>>;
  shellHost: ShellHost;
  cwd: string;
  markerFile: string;
  clock: Clock;
  signal: AbortSignal;
  timeoutMs: number;
  stdin?: string;
  tmpDir?: string;
  inspector?: ProcessInspector;
  groupPort?: ProcessGroupPort;
  owners?: MarkerOwners;
};

type Settled = { durationMs: number; groupNotice?: string };

export type SandboxedCommandResult =
  | ({ kind: 'exited'; exitCode: number; stdout: string; stderr: string } & Settled)
  | ({ kind: 'signaled'; signal: string; stdout: string; stderr: string } & Settled)
  | ({ kind: 'timed_out'; stdout: string; stderr: string } & Settled)
  | ({ kind: 'cancelled'; stderr: string } & Settled)
  | { kind: 'spawn_error'; error: unknown; message: string; durationMs: number };

export const runSandboxedCommand = async (request: SandboxedCommandRequest): Promise<SandboxedCommandResult> => {
  const { sandbox, sandboxPolicy, env, shellHost, cwd, markerFile, clock, signal, timeoutMs, stdin, tmpDir, owners } = request;
  const started = clock.now();
  const elapsed = (): number => Math.max(0, clock.now() - started);
  if (signal.aborted) return { kind: 'cancelled', stderr: '', durationMs: elapsed() };
  if (timeoutMs <= 0) return { kind: 'timed_out', stdout: '', stderr: '', durationMs: elapsed() };

  const controller = new AbortController();
  const onCancel = (): void => controller.abort();
  signal.addEventListener('abort', onCancel, { once: true });
  const timer = cancellableTimer(timeoutMs);
  let timedOut = false;
  void timer.done.then(() => {
    timedOut = true;
    controller.abort();
  });
  const inspector = request.inspector ?? defaultProcessInspector();
  let handle: Awaited<ReturnType<typeof createMarker>> | undefined;
  let settle: ReturnType<typeof createMarkerSettle> | undefined;
  let spawned = false;
  let running = true;
  owners?.register(path.basename(markerFile), { alive: () => running });
  try {
    handle = await createMarker(markerFile, { capability: inspector.capability ?? UNMEASURED_CAPABILITY });
    owners?.remember(path.basename(markerFile), handle.mode);
    settle = createMarkerSettle({ marker: markerFile, mode: handle.mode, inspector, ...(request.groupPort === undefined ? {} : { groupPort: request.groupPort }), onWarning: () => undefined });
    let child: ReturnType<Sandbox['spawn']>;
    try {
      child = await sandbox.spawn(
        {
          argv: 'argv' in request ? [...request.argv] : [resolveBashPath(shellHost.platform, { isExecutable: shellHost.isExecutable, env }), '-c', request.command],
          cwd,
          env: { ...env },
          ...(stdin === undefined ? {} : { stdin }),
          markerFile,
          ...(tmpDir === undefined ? {} : { tmpDir }),
        },
        sandboxPolicy,
        controller.signal,
        { markerFd: handle.fd },
      );
    } catch (error) {
      return { kind: 'spawn_error', error, message: error instanceof Error ? error.message : String(error), durationMs: elapsed() };
    }
    spawned = true;
    const captures = [createCapture(), createCapture()] as const;
    const pump = pumpOutput([child.stdout, child.stderr], (index, chunk) => captures[index === 0 ? 0 : 1].push(chunk));
    let exit: SandboxExit;
    let groupNotice: string | undefined;
    try {
      [exit, groupNotice] = await Promise.all([child.exited, groupRecordOutcome(recordMarkerGroup(markerFile, child.pgid), markerFile)]);
      await settleFinishedCommand(settle, { pgid: child.pgid, exit, signal: controller.signal });
      await pump.settle();
    } finally {
      await pump.close();
    }
    const failure = pump.failure();
    if (failure !== undefined) throw failure.error;
    const stdout = captures[0].text();
    const stderr = captures[1].text();
    const settled: Settled = { durationMs: elapsed(), ...(groupNotice === undefined ? {} : { groupNotice }) };
    if (timedOut) return { kind: 'timed_out', stdout, stderr, ...settled };
    if (signal.aborted) return { kind: 'cancelled', stderr, ...settled };
    if (exit.signal !== null) return { kind: 'signaled', signal: exit.signal, stdout, stderr, ...settled };
    return { kind: 'exited', exitCode: exit.code ?? 0, stdout, stderr, ...settled };
  } finally {
    handle?.close();
    if (handle !== undefined && !spawned) await settle?.discard();
    else await settle?.remove();
    running = false;
    timer.cancel();
    signal.removeEventListener('abort', onCancel);
  }
};

export const verificationMarkerName = (key: { runId: string; round: number; conditionId: string }): string =>
  `verify-${sha256Hex(canonicalJson([key.runId, key.round, key.conditionId]))}`;
