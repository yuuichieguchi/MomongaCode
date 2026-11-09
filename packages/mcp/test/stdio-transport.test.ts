import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { JSONRPCMessage } from '@modelcontextprotocol/client';
import { DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/client/stdio';
import type { McpStdioServerConfig } from '@momonga/config';
import { createStdioTransport, type StdioTransport } from '@momonga/mcp';
import { groupAlive } from '@momonga/foundation';
import type { TerminateOutcome } from '@momonga/foundation';
import { MCP_RAW_STDIO_SERVER_PATH, REAL_PROCESS_TEST_TIMEOUT_MS, killGroupsForCleanup, killPidsForCleanup } from '@momonga/testkit';
import { afterEach, describe, expect, it } from 'vitest';

const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const STDERR_TAIL_BYTES = 64 * 1024;
const PLATFORM_INJECTED_ENV_KEYS = new Set(['__CF_USER_TEXT_ENCODING']);
const FAKE_SECRET = 'not-a-real-key';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'test cleanup failed');
});

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const groupExists = (pgid: number): Promise<boolean> => groupAlive(pgid);

const makeDir = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-mcp-')));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const nodeAlias = (dir: string, name: string): string => {
  fs.mkdirSync(dir, { recursive: true });
  const alias = path.join(dir, name);
  fs.symlinkSync(process.execPath, alias);
  return alias;
};

const baseEnvWith = (pathValue: string): Record<string, string> => ({
  HOME: '/home/fixture-user',
  PATH: pathValue,
  USER: 'fixture-user',
  SHELL: '/bin/zsh',
  OPENAI_API_KEY: FAKE_SECRET,
  MOMONGA_UNRELATED: 'leak',
});

interface Harness {
  transport: StdioTransport;
  messages: JSONRPCMessage[];
  errors: Error[];
  events: Array<'message' | 'close'>;
  closeCount: () => number;
  request: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

interface HarnessOptions {
  config?: Partial<McpStdioServerConfig>;
  modes?: string[];
  projectDir?: string;
  baseEnv?: Record<string, string>;
  closeGraceMs?: number;
  terminate?: (pgid: number, options: { graceMs: number }) => Promise<TerminateOutcome>;
}

const harness = async (options: HarnessOptions = {}): Promise<Harness> => {
  const projectDir = options.projectDir ?? makeDir();
  const config: McpStdioServerConfig = {
    command: process.execPath,
    args: [MCP_RAW_STDIO_SERVER_PATH, ...(options.modes ?? [])],
    ...options.config,
  };
  const transport = createStdioTransport({
    name: 'raw',
    config,
    projectDir,
    baseEnv: options.baseEnv ?? baseEnvWith('/usr/bin:/bin'),
    ...(options.closeGraceMs === undefined ? {} : { closeGraceMs: options.closeGraceMs }),
    ...(options.terminate === undefined ? {} : { terminate: options.terminate }),
  });
  const messages: JSONRPCMessage[] = [];
  const errors: Error[] = [];
  const events: Array<'message' | 'close'> = [];
  let closes = 0;
  const waiters = new Map<number, (message: Record<string, unknown>) => void>();
  transport.onmessage = (message) => {
    messages.push(message);
    events.push('message');
    const record = message as Record<string, unknown>;
    const id = record['id'];
    if (typeof id === 'number') waiters.get(id)?.(record);
  };
  transport.onerror = (error) => {
    errors.push(error);
  };
  transport.onclose = () => {
    closes += 1;
    events.push('close');
    for (const waiter of waiters.values()) waiter({ error: 'transport closed' });
    waiters.clear();
  };
  cleanups.push(async () => {
    const pgid = transport.pgid;
    await transport.close().catch(() => undefined);
    if (pgid !== undefined && pgid > 1) await killGroupsForCleanup([pgid]);
  });
  await transport.start();
  let nextId = 1;
  const request = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const id = nextId;
    nextId += 1;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      waiters.set(id, (message) => {
        waiters.delete(id);
        if ('error' in message) reject(new Error(JSON.stringify(message['error'])));
        else resolve(message['result'] as Record<string, unknown>);
      });
    });
    return transport.send({ jsonrpc: '2.0', id, method, params }).then(() => response);
  };
  return { transport, messages, errors, events, closeCount: () => closes, request };
};

const until = async (predicate: () => boolean | Promise<boolean>, description: string): Promise<void> => {
  const deadline = Date.now() + 20000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const trackGrandchild = (pid: number): void => {
  cleanups.push(() => {
    if (pidAlive(pid)) killPidsForCleanup([pid]);
  });
};

describe('createStdioTransport spawn', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('spawns the server detached in its own process group and exposes the pgid', async () => {
    const { transport, request } = await harness();
    const { pid } = (await request('pid')) as { pid: number };
    expect(transport.pgid).toBe(pid);
    expect(await groupExists(pid)).toBe(true);
  });

  it('resolves a bare command against the composed env PATH, not the test process PATH', async () => {
    const binDir = path.join(makeDir(), 'only-on-composed-path');
    nodeAlias(binDir, 'mm-fixture-node');
    expect((process.env['PATH'] ?? '').split(path.delimiter)).not.toContain(binDir);
    const { request } = await harness({
      config: { command: 'mm-fixture-node' },
      baseEnv: baseEnvWith(['/nonexistent-first', binDir, '/usr/bin', '/bin'].join(path.delimiter)),
    });
    expect(await request('echo', { value: 'found' })).toEqual({ value: 'found' });
  });

  it('resolves a relative command containing a slash against cwd', async () => {
    const projectDir = makeDir();
    nodeAlias(path.join(projectDir, 'server', 'bin'), 'mm-local-node');
    const { request } = await harness({
      projectDir,
      config: { command: './bin/mm-local-node', cwd: 'server' },
    });
    expect(await request('cwd')).toEqual({ cwd: path.join(projectDir, 'server') });
  });

  it('rejects start with an error naming the command and the PATH searched when the command is not found', async () => {
    const searched = ['/nonexistent-a', '/nonexistent-b'].join(path.delimiter);
    const transport = createStdioTransport({
      name: 'missing',
      config: { command: 'mm-definitely-missing-command' },
      projectDir: makeDir(),
      baseEnv: baseEnvWith(searched),
    });
    cleanups.push(() => transport.close().catch(() => undefined));
    const failure = transport.start();
    await expect(failure).rejects.toThrow(/mm-definitely-missing-command/);
    await expect(failure).rejects.toThrow(searched);
  });

  it('defaults cwd to the project dir', async () => {
    const projectDir = makeDir();
    const { request } = await harness({ projectDir });
    expect(await request('cwd')).toEqual({ cwd: projectDir });
  });

  it('resolves a relative config cwd against the project dir', async () => {
    const projectDir = makeDir();
    fs.mkdirSync(path.join(projectDir, 'nested', 'dir'), { recursive: true });
    const { request } = await harness({ projectDir, config: { cwd: 'nested/dir' } });
    expect(await request('cwd')).toEqual({ cwd: path.join(projectDir, 'nested', 'dir') });
  });

  it('passes exactly the default-inherited keys present in baseEnv plus config.env', async () => {
    const baseEnv = { ...baseEnvWith('/usr/bin:/bin'), TERM: 'xterm-fixture' };
    const { request } = await harness({ baseEnv, config: { env: { FIXTURE_FLAG: 'on', HOME: '/override-home' } } });
    const { env } = (await request('env')) as { env: Record<string, string> };
    const seen = Object.fromEntries(Object.entries(env).filter(([key]) => !PLATFORM_INJECTED_ENV_KEYS.has(key)));
    expect([...DEFAULT_INHERITED_ENV_VARS].sort()).toEqual(['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER']);
    expect(seen).toEqual({
      HOME: '/override-home',
      PATH: '/usr/bin:/bin',
      USER: 'fixture-user',
      SHELL: '/bin/zsh',
      TERM: 'xterm-fixture',
      FIXTURE_FLAG: 'on',
    });
    expect(Object.values(env)).not.toContain(FAKE_SECRET);
  });
});

describe('createStdioTransport framing', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('exchanges newline-delimited JSON-RPC in both directions', async () => {
    const { request, messages, transport } = await harness();
    expect(await request('echo', { text: 'line one', nested: { n: 1 } })).toEqual({ text: 'line one', nested: { n: 1 } });
    await transport.send({ jsonrpc: '2.0', method: 'notify_back', params: { tag: 'n1' } });
    await until(() => messages.some((message) => 'method' in message && message.method === 'notifications/echo'), 'notification');
    expect(messages.find((message) => 'method' in message && message.method === 'notifications/echo')).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/echo',
      params: { tag: 'n1' },
    });
  });

  it('reassembles a large message that arrives in many chunks', async () => {
    const { request } = await harness();
    const result = (await request('big', { bytes: 4 * 1024 * 1024 })) as { payload: string };
    expect(result.payload.length).toBe(4 * 1024 * 1024);
    expect(result.payload).toBe('x'.repeat(4 * 1024 * 1024));
  });

  it('reports a message over 16 MiB through onerror and closes', async () => {
    const { transport, errors, closeCount } = await harness();
    const pgid = transport.pgid;
    if (pgid === undefined) throw new Error('missing pgid');
    await transport.send({ jsonrpc: '2.0', id: 99, method: 'oversized', params: { bytes: MAX_MESSAGE_BYTES + 1024 } });
    await until(() => closeCount() === 1, 'close after oversized message');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]).toBeInstanceOf(Error);
    await until(async () => !(await groupExists(pgid)), 'group reaped after oversized message');
  });

  it('reports a non-JSON line through onerror without closing', async () => {
    const { request, errors, closeCount } = await harness();
    expect(await request('garbage')).toEqual({ afterGarbage: true });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(closeCount()).toBe(0);
    expect(await request('echo', { still: 'open' })).toEqual({ still: 'open' });
  });
});

describe('createStdioTransport stderr', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('keeps only the last 64 KiB of stderr in diagnostics and never forwards it to onmessage', async () => {
    const { request, transport, messages } = await harness();
    const head = 'a'.repeat(40 * 1024);
    const tail = `${'b'.repeat(STDERR_TAIL_BYTES - 5)}<END>`;
    const jsonLooking = '{"jsonrpc":"2.0","id":777,"result":{}}\n';
    await request('stderr', { text: jsonLooking });
    await request('stderr', { text: head + tail });
    await until(() => transport.diagnostics().stderrTail.endsWith('<END>'), 'stderr tail');
    expect(transport.diagnostics().stderrTail).toBe(tail);
    expect(Buffer.byteLength(transport.diagnostics().stderrTail)).toBe(STDERR_TAIL_BYTES);
    expect(messages.map((message) => (message as { id?: unknown }).id)).toEqual([1, 2]);
  });

  it('keeps short stderr output whole', async () => {
    const { request, transport } = await harness();
    await request('stderr', { text: 'warming up\n' });
    await until(() => transport.diagnostics().stderrTail === 'warming up\n', 'short stderr');
    expect(transport.diagnostics().stderrTail).toBe('warming up\n');
  });
});

describe('createStdioTransport close', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('ends stdin and lets a cooperative server exit on its own, then reaps the grandchild', async () => {
    const { request, transport, closeCount } = await harness({ closeGraceMs: 10000 });
    const pgid = transport.pgid;
    if (pgid === undefined) throw new Error('missing pgid');
    const { pid: grandchildPid } = (await request('spawn_grandchild')) as { pid: number };
    trackGrandchild(grandchildPid);
    await transport.close();
    expect(transport.diagnostics().exit).toEqual({ code: 0, signal: null });
    expect(pidAlive(grandchildPid)).toBe(false);
    expect(await groupExists(pgid)).toBe(false);
    expect(closeCount()).toBe(1);
  });

  it('sends SIGTERM to the group after the grace when the server ignores stdin end', async () => {
    const { request, transport } = await harness({ modes: ['--linger'], closeGraceMs: 150 });
    const pgid = transport.pgid;
    if (pgid === undefined) throw new Error('missing pgid');
    const { pid: grandchildPid } = (await request('spawn_grandchild')) as { pid: number };
    trackGrandchild(grandchildPid);
    await transport.close();
    expect(transport.diagnostics().exit).toEqual({ code: null, signal: 'SIGTERM' });
    expect(pidAlive(grandchildPid)).toBe(false);
    expect(await groupExists(pgid)).toBe(false);
  });

  it('escalates to SIGKILL after a second grace when the server ignores SIGTERM', async () => {
    const { request, transport } = await harness({ modes: ['--ignore-term'], closeGraceMs: 150 });
    const pgid = transport.pgid;
    if (pgid === undefined) throw new Error('missing pgid');
    const { pid: grandchildPid } = (await request('spawn_grandchild')) as { pid: number };
    trackGrandchild(grandchildPid);
    await transport.close();
    expect(transport.diagnostics().exit).toEqual({ code: null, signal: 'SIGKILL' });
    expect(pidAlive(grandchildPid)).toBe(false);
    expect(await groupExists(pgid)).toBe(false);
  });

  it('is idempotent and fires onclose once', async () => {
    const { transport, closeCount } = await harness({ modes: ['--linger'], closeGraceMs: 100 });
    await Promise.all([transport.close(), transport.close()]);
    await transport.close();
    expect(closeCount()).toBe(1);
  });

  it('rejects send after close', async () => {
    const { transport } = await harness();
    await transport.close();
    await expect(transport.send({ jsonrpc: '2.0', id: 1, method: 'echo', params: {} })).rejects.toThrow();
  });
});

describe('createStdioTransport unexpected exit', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('fires onclose once and records the exit code', async () => {
    const { transport, closeCount } = await harness();
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'exit', params: { code: 5 } });
    await until(() => closeCount() === 1, 'onclose after exit');
    expect(transport.diagnostics().exit).toEqual({ code: 5, signal: null });
    await transport.close();
    expect(closeCount()).toBe(1);
  });

  it('records the terminating signal', async () => {
    const { transport, closeCount } = await harness();
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'kill_self', params: { signal: 'SIGKILL' } });
    await until(() => closeCount() === 1, 'onclose after signal');
    expect(transport.diagnostics().exit).toEqual({ code: null, signal: 'SIGKILL' });
  });

  it('rejects send after the server has exited', async () => {
    const { transport, closeCount } = await harness();
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'exit', params: { code: 0 } });
    await until(() => closeCount() === 1, 'onclose after exit');
    await expect(transport.send({ jsonrpc: '2.0', id: 2, method: 'echo', params: {} })).rejects.toThrow();
  });
});

const SHELLSHOCK_VALUE = '() { :; }; echo pwned';

const writeScript = (file: string, body: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
};

const collectUnhandledRejections = (): unknown[] => {
  const seen: unknown[] = [];
  const listener = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on('unhandledRejection', listener);
  cleanups.push(() => {
    process.off('unhandledRejection', listener);
  });
  return seen;
};

const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const failingTerminate = (calls: number[]) => (pgid: number): Promise<TerminateOutcome> => {
  calls.push(pgid);
  return Promise.reject(new Error('terminate failed for test'));
};

describe('createStdioTransport env value filter', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('drops inherited values that start with "()" but passes the same value from config.env', async () => {
    const baseEnv = { ...baseEnvWith('/usr/bin:/bin'), SHELL: SHELLSHOCK_VALUE };
    const { request } = await harness({ baseEnv, config: { env: { TERM: SHELLSHOCK_VALUE } } });
    const { env } = (await request('env')) as { env: Record<string, string> };
    expect(env['SHELL']).toBeUndefined();
    expect(env['TERM']).toBe(SHELLSHOCK_VALUE);
    expect(env['HOME']).toBe('/home/fixture-user');
  });
});

describe('createStdioTransport relative PATH entries', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('ignores relative PATH entries and picks the command from an absolute directory', async () => {
    const projectDir = makeDir();
    const marker = path.join(projectDir, 'hostile-ran');
    for (const relative of ['.', 'bin', path.join('node_modules', '.bin')]) {
      writeScript(path.join(projectDir, relative, 'mm-path-cmd'), `touch ${JSON.stringify(marker)}; exit 42`);
    }
    const realDir = path.join(makeDir(), 'real-bin');
    nodeAlias(realDir, 'mm-path-cmd');
    const { request } = await harness({
      projectDir,
      config: { command: 'mm-path-cmd' },
      baseEnv: baseEnvWith(['.', './bin', 'node_modules/.bin', realDir, '/usr/bin', '/bin'].join(path.delimiter)),
    });
    expect(await request('echo', { real: true })).toEqual({ real: true });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('fails with the not-found message when only a relative PATH entry would match', async () => {
    const projectDir = makeDir();
    writeScript(path.join(projectDir, 'node_modules', '.bin', 'mm-only-relative'), 'exit 42');
    const searched = ['node_modules/.bin', '/nonexistent-abs'].join(path.delimiter);
    const transport = createStdioTransport({
      name: 'relative',
      config: { command: 'mm-only-relative' },
      projectDir,
      baseEnv: baseEnvWith(searched),
    });
    cleanups.push(async () => {
      const pgid = transport.pgid;
      await transport.close().catch(() => undefined);
      if (pgid !== undefined && pgid > 1) await killGroupsForCleanup([pgid]);
    });
    const failure = transport.start();
    await expect(failure).rejects.toThrow(/mm-only-relative/);
    await expect(failure).rejects.toThrow(searched);
  });
});

describe('createStdioTransport blank lines', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('skips empty and carriage-return-only lines silently', async () => {
    const { request, errors, messages } = await harness();
    expect(await request('blank_lines')).toEqual({ afterBlank: true });
    expect(await request('echo', { next: 1 })).toEqual({ next: 1 });
    expect(errors).toEqual([]);
    expect(messages.map((message) => (message as { id?: unknown }).id)).toEqual([1, 2]);
  });
});

describe('createStdioTransport stdout drain on unexpected exit', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('delivers every complete message written before stdout EOF ahead of onclose', async () => {
    const { transport, messages, events, closeCount } = await harness({ closeGraceMs: 10000 });
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'late_write', params: { count: 3, bytes: 200 * 1024 } });
    await until(() => closeCount() === 1, 'onclose after leader exit');
    const late = messages.filter((message) => 'method' in message && message.method === 'notifications/late');
    expect(late.map((message) => (message as unknown as { params: { index: number } }).params.index)).toEqual([0, 1, 2]);
    expect(late.every((message) => (message as unknown as { params: { payload: string } }).params.payload.length === 200 * 1024)).toBe(true);
    expect(events).toEqual(['message', 'message', 'message', 'close']);
    expect(transport.diagnostics().exit).toEqual({ code: 0, signal: null });
  });
});

describe('createStdioTransport terminate failures on internal close paths', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('fires onclose once and reports the error on unexpected exit without an unhandled rejection', async () => {
    const unhandled = collectUnhandledRejections();
    const calls: number[] = [];
    const { transport, errors, closeCount } = await harness({ terminate: failingTerminate(calls) });
    const pgid = transport.pgid;
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'exit', params: { code: 3 } });
    await until(() => closeCount() === 1, 'onclose after exit');
    await macrotask();
    await macrotask();
    expect(calls).toEqual([pgid]);
    expect(closeCount()).toBe(1);
    expect(errors.map((error) => error.message)).toContainEqual(expect.stringContaining('terminate failed for test'));
    expect(unhandled).toEqual([]);
  });

  it('fires onclose once and reports the error after an oversized message without an unhandled rejection', async () => {
    const unhandled = collectUnhandledRejections();
    const calls: number[] = [];
    const { transport, errors, closeCount } = await harness({ terminate: failingTerminate(calls) });
    const pgid = transport.pgid;
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'oversized', params: { bytes: MAX_MESSAGE_BYTES + 1024 } });
    await until(() => closeCount() === 1, 'onclose after oversized message');
    await macrotask();
    await macrotask();
    expect(calls).toEqual([pgid]);
    expect(closeCount()).toBe(1);
    expect(errors.map((error) => error.message)).toContainEqual(expect.stringContaining('terminate failed for test'));
    expect(unhandled).toEqual([]);
  });

  it('lets an explicit close reject to its caller while onclose still fires once', async () => {
    const unhandled = collectUnhandledRejections();
    const calls: number[] = [];
    const { transport, closeCount } = await harness({ modes: ['--linger'], closeGraceMs: 50, terminate: failingTerminate(calls) });
    await expect(transport.close()).rejects.toThrow('terminate failed for test');
    await macrotask();
    expect(calls).toEqual([transport.pgid]);
    expect(closeCount()).toBe(1);
    expect(unhandled).toEqual([]);
  });
});

const readEscapedPid = async (readyFile: string): Promise<number> => {
  await until(() => fs.existsSync(readyFile), 'escaped grandchild ready file');
  const pid = Number(fs.readFileSync(readyFile, 'utf8'));
  cleanups.push(() => {
    if (pid > 1 && pidAlive(pid)) killPidsForCleanup([pid]);
  });
  return pid;
};

const ESCAPED_HOST_PATH = path.join(import.meta.dirname, 'fixtures', 'escaped-grandchild-host.ts');
const QUIET_WINDOW_MS = 300;

describe('createStdioTransport pipes after close', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('stops reading stdout and stderr once onclose fires even if an escaped grandchild holds the pipes', async () => {
    const dir = makeDir();
    const readyFile = path.join(dir, 'escaped.pid');
    const { transport, messages, closeCount } = await harness({ closeGraceMs: 100 });
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'escape_grandchild', params: { readyFile } });
    const escapedPid = await readEscapedPid(readyFile);
    await until(() => closeCount() === 1, 'onclose after leader exit');
    const stderrBefore = transport.diagnostics().stderrTail;
    const messagesBefore = messages.length;
    process.kill(escapedPid, 'SIGUSR1');
    await until(() => fs.existsSync(`${readyFile}.ack`), 'escaped grandchild wrote');
    await new Promise((resolve) => setTimeout(resolve, QUIET_WINDOW_MS));
    expect(fs.readFileSync(`${readyFile}.ack`, 'utf8')).toBe('stdout=EPIPE stderr=EPIPE\n');
    expect(pidAlive(escapedPid)).toBe(true);
    expect(messages.length).toBe(messagesBefore);
    expect(transport.diagnostics().stderrTail).toBe(stderrBefore);
    expect(transport.diagnostics().stderrTail).not.toContain('escaped-stderr');
  });

  it('does not keep the host process alive after onclose while an escaped grandchild lives', async () => {
    const dir = makeDir();
    const readyFile = path.join(dir, 'escaped.pid');
    const host = spawn(process.execPath, [ESCAPED_HOST_PATH, MCP_RAW_STDIO_SERVER_PATH, readyFile, dir], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    cleanups.push(() => {
      if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
    });
    const exited = new Promise<number | null>((resolve) => host.once('exit', (code) => resolve(code)));
    let stdout = '';
    host.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    const escapedPid = await readEscapedPid(readyFile);
    await until(() => stdout.includes('closed\n'), 'host reported onclose');
    const outcome = await Promise.race([
      exited.then((code) => ({ exited: true, code })),
      new Promise<{ exited: false }>((resolve) => setTimeout(() => resolve({ exited: false }), 3000)),
    ]);
    expect(pidAlive(escapedPid)).toBe(true);
    expect(outcome).toEqual({ exited: true, code: 0 });
  });
});

describe('createStdioTransport terminate failure reporting', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('reports a terminate failure through onerror exactly once when oversize and leader exit both close', async () => {
    const calls: number[] = [];
    const { transport, errors, closeCount } = await harness({ terminate: failingTerminate(calls) });
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'oversized', params: { bytes: MAX_MESSAGE_BYTES + 1024 } });
    await until(() => closeCount() === 1, 'onclose after oversized message');
    await until(() => transport.diagnostics().exit !== null, 'leader exit after stdin end');
    await macrotask();
    await macrotask();
    expect(errors.filter((error) => error.message.includes('terminate failed for test'))).toHaveLength(1);
    expect(closeCount()).toBe(1);
  });
});
