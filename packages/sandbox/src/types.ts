import type { FileRuleSet, ProtectedSet } from '@momonga/foundation';

export interface SandboxPolicy {
  writableRoots: readonly string[];
  writeDenied: readonly string[];
  writeDeniedLiterals: readonly string[];
  readDenied: readonly string[];
  readAllowed?: readonly string[];
  network: 'deny' | 'allow';
  fileRules: FileRuleSet;
  protectedSet: ProtectedSet;
}

export interface SandboxCommand {
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  markerFile?: string;
  tmpDir?: string;
  stdin?: string;
}

export interface SandboxExit {
  code: number | null;
  signal: string | null;
  killedBy?: 'abort' | 'grace-kill';
}

export interface SandboxedProcess {
  pid: number;
  pgid: number;
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  exited: Promise<SandboxExit>;
}

export interface Sandbox {
  kind: 'seatbelt' | 'bubblewrap' | 'none';
  sweep?(): void;
  spawn(command: SandboxCommand, policy: SandboxPolicy, signal: AbortSignal): SandboxedProcess;
}
