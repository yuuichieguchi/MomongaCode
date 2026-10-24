import { execFileSync } from 'node:child_process';
import type { E2eCase } from './cases.ts';

export const SANDBOX_ENV = 'MOMONGA_E2E_SANDBOX';
export const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';
export const SANDBOX_PROBE_ARGS = ['-p', '(version 1)(allow default)', '/usr/bin/true'] as const;
export const SANDBOX_FALLBACK = 'sandbox-exec unusable';

export type SandboxProbe = { usable: true } | { usable: false; stderr: string };

export type SandboxProbeRunner = (file: string, args: readonly string[]) => void;

export type SandboxResolution = { kind: 'seatbelt' } | { kind: 'none'; sandboxFallback: typeof SANDBOX_FALLBACK } | { kind: 'skip'; reason: string };

const stderrOf = (error: unknown): string => {
  if (typeof error === 'object' && error !== null && 'stderr' in error) {
    const stderr = String((error as { stderr: unknown }).stderr ?? '').trim();
    if (stderr !== '') return stderr;
  }
  return error instanceof Error ? error.message : String(error);
};

export const execSandboxProbe: SandboxProbeRunner = (file, args) => {
  execFileSync(file, args, { stdio: ['ignore', 'ignore', 'pipe'] });
};

export const runSandboxProbe = (runner: SandboxProbeRunner = execSandboxProbe): SandboxProbe => {
  try {
    runner(SANDBOX_EXEC_PATH, SANDBOX_PROBE_ARGS);
    return { usable: true };
  } catch (error) {
    return { usable: false, stderr: stderrOf(error) };
  }
};

export const encodeSandboxProbe = (probe: SandboxProbe): string => (probe.usable ? 'usable' : `unusable:${probe.stderr}`);

export const sandboxLine = (probe: SandboxProbe, cases: readonly E2eCase[]): string => {
  if (probe.usable) return 'e2e sandbox: seatbelt (sandbox-exec usable)';
  const bash = cases.filter((entry) => entry.needsBash).length;
  return `e2e sandbox: sandbox-exec UNUSABLE; ${bash} bash cases will be skipped, ${cases.length - bash} cases run with sandbox none`;
};

const UNUSABLE_PREFIX = 'unusable:';

export const decodeSandboxProbe = (encoded: string): SandboxProbe => {
  if (encoded === 'usable') return { usable: true };
  if (encoded.startsWith(UNUSABLE_PREFIX)) return { usable: false, stderr: encoded.slice(UNUSABLE_PREFIX.length) };
  throw new Error(`${SANDBOX_ENV} must be "usable" or "unusable:<stderr>", got ${encoded}`);
};

export const sandboxProbe = (env: Record<string, string | undefined> = process.env, runner: SandboxProbeRunner = execSandboxProbe): SandboxProbe => {
  const published = env[SANDBOX_ENV];
  if (published !== undefined) return decodeSandboxProbe(published);
  const probe = runSandboxProbe(runner);
  env[SANDBOX_ENV] = encodeSandboxProbe(probe);
  return probe;
};

export const resolveSandbox = (options: { needsBash: boolean }, probe: SandboxProbe = sandboxProbe()): SandboxResolution => {
  if (probe.usable) return { kind: 'seatbelt' };
  if (options.needsBash) return { kind: 'skip', reason: `sandbox-exec is not usable on this host: ${probe.stderr}` };
  return { kind: 'none', sandboxFallback: SANDBOX_FALLBACK };
};

export const seatbeltOrSkip = (context: { skip: (note?: string) => void }): void => {
  const resolution = resolveSandbox({ needsBash: true });
  if (resolution.kind === 'skip') context.skip(resolution.reason);
};
