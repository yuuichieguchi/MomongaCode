import { spawnSync } from '@momonga/testkit/child-process';
import path from 'node:path';
import { SANDBOX_LAUNCHERS_LOOKED_FOR, defaultSandboxSetting, executableSandboxLauncher, hostLauncherExecutable } from '@momonga/config';
import type { LauncherCheck, SandboxSetting } from '@momonga/config';
import { nodeFileSystemSync } from '@momonga/foundation';
import { DEFAULT_BWRAP_PATH, SANDBOX_STOP_BOUND_MS, bwrapProbeArguments } from '@momonga/sandbox';
import { executableCheckNowOn, resolveBashPathNow } from '@momonga/tools';
import type { E2eCase } from './cases.ts';

export const SANDBOX_ENV = 'MOMONGA_E2E_SANDBOX';
export const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';
export const SANDBOX_PROBE_ARGS = ['-p', '(version 1)(allow default)', '/usr/bin/true'] as const;
export const SANDBOX_PROBE_TIMEOUT_MS = SANDBOX_STOP_BOUND_MS;

export type ProductSandbox = Exclude<SandboxSetting, 'none'>;

export const LAUNCHER_PATH: Readonly<Record<ProductSandbox, string>> = { seatbelt: SANDBOX_EXEC_PATH, bubblewrap: DEFAULT_BWRAP_PATH };

export const REFUSED_WRITE_TEXT: Readonly<Record<ProductSandbox, string>> = { seatbelt: 'Operation not permitted', bubblewrap: 'Read-only file system' };

export const REFUSED_READ_TEXT: Readonly<Record<ProductSandbox, string>> = { seatbelt: 'Operation not permitted', bubblewrap: 'No such file or directory' };

export const SIGTERM_DEATH: Readonly<Record<ProductSandbox, { exitCode: number | null; signal: NodeJS.Signals | null }>> = {
  seatbelt: { exitCode: null, signal: 'SIGTERM' },
  bubblewrap: { exitCode: 143, signal: null },
};

export const SANDBOX_ENDS_WITH_RUNTIME: Readonly<Record<ProductSandbox, boolean>> = { seatbelt: false, bubblewrap: true };

export type SandboxProbe = { usable: true; kind: ProductSandbox } | { usable: false; kind: SandboxSetting; stderr: string };

export type SandboxProbeRunner = (file: string, args: readonly string[], timeoutMs: number) => { status: number | null; stderr: string; timedOut: boolean };

export type SandboxResolution = { kind: ProductSandbox } | { kind: 'none'; sandboxFallback: string } | { kind: 'skip'; reason: string };

export const platformSandbox = (executable: LauncherCheck = hostLauncherExecutable): ProductSandbox => defaultSandboxSetting(executable);

export const productSandbox = (): ProductSandbox => platformSandbox();

export const spawnSandboxProbe: SandboxProbeRunner = (file, args, timeoutMs) => {
  const done = spawnSync(file, [...args], { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', stdio: ['ignore', 'ignore', 'pipe'] });
  if (done.error !== undefined && (done.error as NodeJS.ErrnoException).code !== 'ETIMEDOUT') throw done.error;
  return { status: done.status, stderr: done.stderr ?? '', timedOut: done.error !== undefined };
};

const LAUNCHER_NAME: Readonly<Record<ProductSandbox, string>> = { seatbelt: 'sandbox-exec', bubblewrap: 'bwrap' };

const probeLauncher = (kind: ProductSandbox, args: readonly string[], run: SandboxProbeRunner): SandboxProbe => {
  const { status, stderr, timedOut } = run(LAUNCHER_PATH[kind], args, SANDBOX_PROBE_TIMEOUT_MS);
  if (timedOut) return { usable: false, kind, stderr: `${LAUNCHER_NAME[kind]} did not finish within ${SANDBOX_PROBE_TIMEOUT_MS} ms` };
  if (status === 0) return { usable: true, kind };
  const reported = stderr.trim();
  return { usable: false, kind, stderr: reported === '' ? `${LAUNCHER_NAME[kind]} exited with status ${String(status)}` : reported };
};

const probeProductSandbox = (kind: ProductSandbox, platform: NodeJS.Platform, run: SandboxProbeRunner): SandboxProbe =>
  probeLauncher(kind, kind === 'seatbelt' ? SANDBOX_PROBE_ARGS : bwrapProbeArguments(resolveBashPathNow(platform, { isExecutable: executableCheckNowOn(nodeFileSystemSync), env: process.env })), run);

export const runSandboxProbe = (platform: NodeJS.Platform = process.platform, run: SandboxProbeRunner = spawnSandboxProbe, executable: LauncherCheck = hostLauncherExecutable): SandboxProbe => {
  const found = executableSandboxLauncher(executable);
  if (found === undefined) return { usable: false, kind: platformSandbox(executable), stderr: `no sandbox launcher is executable: looked for ${SANDBOX_LAUNCHERS_LOOKED_FOR}` };
  const { kind } = found;
  try {
    return probeProductSandbox(kind, platform, run);
  } catch (error) {
    return { usable: false, kind, stderr: error instanceof Error ? error.message : String(error) };
  }
};

export const encodeSandboxProbe = (probe: SandboxProbe): string => (probe.usable ? `usable:${probe.kind}` : `unusable:${probe.kind}:${probe.stderr}`);

export const sandboxLine = (probe: SandboxProbe, cases: readonly E2eCase[]): string => {
  if (probe.usable) return `e2e sandbox: ${probe.kind} (${path.basename(LAUNCHER_PATH[probe.kind])} usable)`;
  const bash = cases.filter((entry) => entry.needsBash).length;
  return `e2e sandbox: ${probe.kind} UNUSABLE (${probe.stderr}); ${bash} bash cases will be skipped, ${cases.length - bash} cases run with sandbox none`;
};

const PRODUCT_SANDBOXES: readonly string[] = Object.keys(LAUNCHER_PATH);
const SANDBOX_SETTINGS: readonly string[] = [...PRODUCT_SANDBOXES, 'none'];

const isProductSandbox = (value: string): value is ProductSandbox => PRODUCT_SANDBOXES.includes(value);
const isSandboxSetting = (value: string): value is SandboxSetting => SANDBOX_SETTINGS.includes(value);

const malformed = (encoded: string): Error => new Error(`${SANDBOX_ENV} must be "usable:<sandbox>" or "unusable:<sandbox>:<stderr>", got ${encoded}`);

export const decodeSandboxProbe = (encoded: string): SandboxProbe => {
  const [state, kind = '', ...rest] = encoded.split(':');
  if (state === 'usable' && rest.length === 0 && isProductSandbox(kind)) return { usable: true, kind };
  if (state === 'unusable' && rest.length > 0 && isSandboxSetting(kind)) return { usable: false, kind, stderr: rest.join(':') };
  throw malformed(encoded);
};

export const sandboxProbe = (
  env: Record<string, string | undefined> = process.env,
  run: SandboxProbeRunner = spawnSandboxProbe,
  platform: NodeJS.Platform = process.platform,
  executable: LauncherCheck = hostLauncherExecutable,
): SandboxProbe => {
  const published = env[SANDBOX_ENV];
  if (published !== undefined) return decodeSandboxProbe(published);
  const probe = runSandboxProbe(platform, run, executable);
  env[SANDBOX_ENV] = encodeSandboxProbe(probe);
  return probe;
};

export const resolveSandbox = (options: { needsBash: boolean }, probe: SandboxProbe = sandboxProbe()): SandboxResolution => {
  if (probe.usable) return { kind: probe.kind };
  if (options.needsBash) return { kind: 'skip', reason: `the ${probe.kind} sandbox is not usable on this host: ${probe.stderr}` };
  return { kind: 'none', sandboxFallback: `${probe.kind} unusable` };
};

export const sandboxOrSkip = (context: { skip: (note?: string) => void }): void => {
  const resolution = resolveSandbox({ needsBash: true });
  if (resolution.kind === 'skip') context.skip(resolution.reason);
};
