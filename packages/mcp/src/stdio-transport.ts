import { spawn, type ChildProcessByStdio } from 'node:child_process';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Readable, Stream, Writable } from 'node:stream';
import { deserializeMessage, serializeMessage, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/client';
import { DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/client/stdio';
import type { McpStdioServerConfig } from '@momonga/config';
import { reapMarkedProcesses, terminateGroup, type TerminateOutcome } from '@momonga/foundation';

const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const STDERR_TAIL_BYTES = 64 * 1024;
const DEFAULT_CLOSE_GRACE_MS = 2000;
const NEWLINE = 0x0a;

export type McpMarkerOptions = { dir: string; onWarning(message: string): void };

export interface StdioTransportOptions {
  name: string;
  config: McpStdioServerConfig;
  projectDir: string;
  baseEnv: Record<string, string>;
  closeGraceMs?: number;
  markers?: McpMarkerOptions;
  terminate?: (pgid: number, options: { graceMs: number }) => Promise<TerminateOutcome>;
}

export interface StdioTransportExit {
  code: number | null;
  signal: string | null;
}

export interface StdioTransportDiagnostics {
  stderrTail: string;
  exit: StdioTransportExit | null;
}

export interface StdioTransport extends Transport {
  readonly pgid: number | undefined;
  diagnostics(): StdioTransportDiagnostics;
}

type ServerProcess = ChildProcessByStdio<Writable, Readable, Readable>;

export function inheritedEnvOf(baseEnv: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of DEFAULT_INHERITED_ENV_VARS) {
    const value = baseEnv[key];
    if (value !== undefined && !value.startsWith('()')) env[key] = value;
  }
  return env;
}

function composeEnv(baseEnv: Record<string, string>, overlay: Record<string, string> | undefined): Record<string, string> {
  return { ...inheritedEnvOf(baseEnv), ...overlay };
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveCommand(command: string, cwd: string, searchPath: string): string {
  if (command.includes('/')) {
    const resolved = path.resolve(cwd, command);
    if (!isExecutableFile(resolved)) throw new Error(`MCP server command "${command}" is not an executable file (resolved to ${resolved})`);
    return resolved;
  }
  for (const directory of searchPath.split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.resolve(cwd, directory, command);
    if (isExecutableFile(candidate)) return candidate;
  }
  throw new Error(`MCP server command "${command}" not found in PATH: ${searchPath}`);
}

class StdioTransportImpl implements StdioTransport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: (<T extends JSONRPCMessage>(message: T) => void) | undefined;

  private child: ServerProcess | undefined;
  private exit: StdioTransportExit | null = null;
  private exited: Promise<void> = Promise.resolve();
  private stdoutEnded: Promise<void> = Promise.resolve();
  private stderrTail: Buffer = Buffer.alloc(0);
  private pendingChunks: Buffer[] = [];
  private pendingBytes = 0;
  private closing: Promise<void> | undefined;
  private closed = false;
  private deliveryStopped = false;
  private readonly closeGraceMs: number;
  private markerPath: string | undefined;

  private readonly options: StdioTransportOptions;

  constructor(options: StdioTransportOptions) {
    this.options = options;
    this.closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
  }

  get pgid(): number | undefined {
    return this.child?.pid;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get stderr(): Stream | null {
    return null;
  }

  diagnostics(): StdioTransportDiagnostics {
    return { stderrTail: this.stderrTail.toString('utf8'), exit: this.exit };
  }

  async start(): Promise<void> {
    if (this.child !== undefined) throw new Error(`MCP server "${this.options.name}" transport already started`);
    const { config, projectDir, baseEnv } = this.options;
    const cwd = path.resolve(projectDir, config.cwd ?? '.');
    const env = composeEnv(baseEnv, config.env);
    const markerPath = this.options.markers === undefined ? undefined : path.join(this.options.markers.dir, randomUUID());
    let child: ServerProcess;
    try {
      child = this.spawnServer(config, cwd, env, markerPath);
    } catch (error) {
      if (markerPath !== undefined) fs.rmSync(markerPath, { force: true });
      throw error;
    }
    this.child = child;
    this.markerPath = markerPath;
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('spawn', () => {
          child.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      this.markerPath = undefined;
      if (markerPath !== undefined) fs.rmSync(markerPath, { force: true });
      throw error;
    }
    if (markerPath !== undefined) fs.writeFileSync(markerPath, `${child.pid}\n`);
    this.exited = new Promise<void>((resolve) => {
      child.once('exit', (code, signal) => {
        this.exit = { code, signal };
        resolve();
        void this.drainThenClose();
      });
    });
    this.stdoutEnded = new Promise<void>((resolve) => {
      child.stdout.once('close', resolve);
    });
    child.once('error', (error) => this.reportError(error));
    child.stdin.on('error', (error) => this.reportError(error));
    child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on('data', (chunk: Buffer) => this.onStderr(chunk));
  }

  private spawnServer(config: McpStdioServerConfig, cwd: string, env: Record<string, string>, markerPath: string | undefined): ServerProcess {
    const file = resolveCommand(config.command, cwd, env['PATH'] ?? '');
    const args = config.args ?? [];
    if (markerPath === undefined) return spawn(file, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const markerFd = fs.openSync(markerPath, 'wx', 0o600);
    try {
      return spawn(file, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe', markerFd] }) as ServerProcess;
    } finally {
      fs.closeSync(markerFd);
    }
  }

  send(message: JSONRPCMessage): Promise<void> {
    const child = this.child;
    if (child === undefined || this.closed || this.closing !== undefined || this.exit !== null) {
      return Promise.reject(new Error(`MCP server "${this.options.name}" transport is not connected`));
    }
    return new Promise<void>((resolve, reject) => {
      child.stdin.write(serializeMessage(message), (error) => (error === null || error === undefined ? resolve() : reject(error)));
    });
  }

  close(): Promise<void> {
    this.deliveryStopped = true;
    return this.beginClose(false);
  }

  private beginClose(internal: boolean): Promise<void> {
    if (this.closing === undefined) {
      const closing = this.shutdown();
      this.closing = closing;
      if (internal) closing.catch((error: unknown) => this.reportError(error instanceof Error ? error : new Error(String(error))));
    }
    return this.closing;
  }

  private async drainThenClose(): Promise<void> {
    await this.raceTimeout(this.stdoutEnded);
    this.closeReportingErrors();
  }

  private closeReportingErrors(): void {
    void this.beginClose(true);
  }

  private async shutdown(): Promise<void> {
    try {
      const child = this.child;
      if (child !== undefined && child.pid !== undefined) {
        child.stdin.end();
        await this.raceTimeout(this.exited);
        let terminateFailure: { error: unknown } | undefined;
        try {
          await (this.options.terminate ?? terminateGroup)(child.pid, { graceMs: this.closeGraceMs });
        } catch (error) {
          terminateFailure = { error };
        }
        await this.raceTimeout(this.stdoutEnded);
        let sweepFailure: { error: unknown } | undefined;
        if (this.markerPath !== undefined && this.options.markers !== undefined) {
          try {
            await reapMarkedProcesses({
              marker: this.markerPath,
              pgid: child.pid,
              killGraceMs: this.closeGraceMs,
              label: 'mcp',
              onWarning: this.options.markers.onWarning,
            });
          } catch (error) {
            sweepFailure = { error };
          }
        }
        if (terminateFailure !== undefined && sweepFailure !== undefined) {
          throw new AggregateError([terminateFailure.error, sweepFailure.error], 'terminating the MCP server group and sweeping its marker both failed');
        }
        if (terminateFailure !== undefined) throw terminateFailure.error;
        if (sweepFailure !== undefined) throw sweepFailure.error;
      }
    } finally {
      const child = this.child;
      if (child !== undefined) {
        child.stdout.removeAllListeners('data');
        child.stderr.removeAllListeners('data');
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
      }
      this.pendingChunks = [];
      this.pendingBytes = 0;
      this.closed = true;
      this.onclose?.();
    }
  }

  private async raceTimeout(promise: Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.closeGraceMs);
    });
    try {
      await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private reportError(error: Error): void {
    this.onerror?.(error);
  }

  private onStderr(chunk: Buffer): void {
    const combined = Buffer.concat([this.stderrTail, chunk]);
    this.stderrTail = combined.length > STDERR_TAIL_BYTES ? Buffer.from(combined.subarray(combined.length - STDERR_TAIL_BYTES)) : combined;
  }

  private onStdout(chunk: Buffer): void {
    if (this.deliveryStopped) return;
    let rest = chunk;
    for (;;) {
      const index = rest.indexOf(NEWLINE);
      const lineBytes = this.pendingBytes + (index === -1 ? rest.length : index);
      if (lineBytes > MAX_MESSAGE_BYTES) {
        this.reportError(new Error(`MCP server "${this.options.name}" sent a message over ${MAX_MESSAGE_BYTES} bytes`));
        this.deliveryStopped = true;
        this.pendingChunks = [];
        this.pendingBytes = 0;
        this.closeReportingErrors();
        return;
      }
      if (index === -1) {
        this.pendingChunks.push(rest);
        this.pendingBytes += rest.length;
        return;
      }
      const line = Buffer.concat([...this.pendingChunks, rest.subarray(0, index)]);
      this.pendingChunks = [];
      this.pendingBytes = 0;
      this.deliver(line.toString('utf8').replace(/\r$/, ''));
      rest = rest.subarray(index + 1);
    }
  }

  private deliver(line: string): void {
    if (line === '') return;
    let message: JSONRPCMessage;
    try {
      message = deserializeMessage(line);
    } catch (error) {
      this.reportError(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.onmessage?.(message);
  }
}

export function createStdioTransport(options: StdioTransportOptions): StdioTransport {
  return new StdioTransportImpl(options);
}
