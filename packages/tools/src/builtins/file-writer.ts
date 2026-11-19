import path from 'node:path';
import { kernelLockNamed, writeFileAtomically as writeFileAtomicallyThroughLock } from '@momonga/foundation';
import type { AtomicWriteFileSystem, ExecutableHelper, FileSystem, HelperSelf, KernelLockMechanism, Random } from '@momonga/foundation';
import { helperCommandLine } from '@momonga/foundation';
import type { Sandbox, SandboxPolicy } from '@momonga/sandbox';
import type { ToolContext } from '../types.ts';

export const FILE_WRITER_HELPER = 'file-writer';

export type WriterLaunch = { readonly argv: readonly string[] };

export const writerLaunchOf = (self: HelperSelf): WriterLaunch => ({ argv: helperCommandLine(self, FILE_WRITER_HELPER, []) });

export type WriterRequest = { target: string; content: string; mode: number; lock: KernelLockMechanism['name'] };

export type WriterAnswer =
  | { kind: 'written'; syncFailure?: string }
  | { kind: 'moved'; expected: string; actual: string; workspaceUnchanged?: true }
  | { kind: 'failed'; message: string; workspaceUnchanged?: true };

export type WriterChild = { sandbox: Sandbox; sandboxPolicy: SandboxPolicy; launch: WriterLaunch; cwd: string; env: Readonly<Record<string, string>>; signal: AbortSignal };

class MovedError extends Error {
  readonly expected: string;
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super(`${expected} resolves to ${actual}`);
    this.expected = expected;
    this.actual = actual;
  }
}

const exists = async (files: FileSystem, file: string): Promise<boolean> => {
  try {
    await files.stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

const resolvesTo = async (files: FileSystem, directory: string): Promise<void> => {
  const actual = await files.realpath(directory);
  if (actual !== directory) throw new MovedError(directory, actual);
};

const createMissingDirectories = async (files: FileSystem, directory: string, made: { any: boolean }): Promise<void> => {
  const missing: string[] = [];
  for (let current = directory; !(await exists(files, current)); current = path.dirname(current)) missing.push(current);
  for (const level of missing.reverse()) {
    await files.makeDirectory(level);
    made.any = true;
    try {
      await resolvesTo(files, level);
    } catch (error) {
      await files.removeEmptyDirectory(level).catch((removeError: unknown) => {
        const code = (removeError as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'ENOTDIR') throw removeError;
      });
      throw error;
    }
  }
};

const recordingDirectorySync = (files: FileSystem, directory: string, failures: unknown[]): AtomicWriteFileSystem => ({
  ...files,
  open: async (file, flags, mode) => {
    const handle = await files.open(file, flags, mode);
    if (file !== directory) return handle;
    return {
      ...handle,
      sync: async () => {
        try {
          await handle.sync();
        } catch (error) {
          failures.push(error);
        }
      },
    };
  },
});

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const writeRequested = async (ports: { files: FileSystem; random: Random }, request: WriterRequest): Promise<WriterAnswer> => {
  const { files } = ports;
  const directory = path.dirname(request.target);
  const syncFailures: unknown[] = [];
  const made = { any: false };
  let reached: 'before-write' | 'write' | 'failed-unchanged' = 'before-write';
  try {
    await createMissingDirectories(files, directory, made);
    await resolvesTo(files, directory);
    reached = 'write';
    await writeFileAtomicallyThroughLock(recordingDirectorySync(files, directory, syncFailures), ports.random, request.target, request.content, {
      mode: request.mode,
      lock: kernelLockNamed(request.lock),
      beforePublish: () => resolvesTo(files, directory),
      onFailedUnchanged: () => {
        reached = 'failed-unchanged';
      },
    });
  } catch (error) {
    const unchanged = !made.any && reached !== 'write' ? { workspaceUnchanged: true as const } : {};
    if (error instanceof MovedError) return { kind: 'moved', expected: error.expected, actual: error.actual, ...unchanged };
    return { kind: 'failed', message: messageOf(error), ...unchanged };
  }
  return syncFailures.length === 0 ? { kind: 'written' } : { kind: 'written', syncFailure: messageOf(syncFailures[0]) };
};

const isLockName = (value: unknown): value is KernelLockMechanism['name'] => value === 'file-lock' || value === 'sqlite-lock';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const requestOf = (text: string): WriterRequest => {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error('the request of the file writer is not an object');
  const { target, content, mode, lock } = parsed;
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('the request of the file writer names no absolute path');
  if (typeof content !== 'string') throw new Error('the request of the file writer carries no content');
  if (typeof mode !== 'number' || !Number.isInteger(mode)) throw new Error('the request of the file writer carries no mode');
  if (!isLockName(lock)) throw new Error('the request of the file writer names no known lock');
  return { target, content: Buffer.from(content, 'base64').toString('utf8'), mode, lock };
};

const readAll = async (stream: NodeJS.ReadableStream): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
};

export const fileWriterOn =
  (ports: { files: FileSystem; random: Random }): ExecutableHelper =>
  async (host) => {
    const answer = await writeRequested(ports, requestOf(await readAll(host.stdin)));
    host.stdout.write(JSON.stringify(answer));
    return 0;
  };

const answerOf = (text: string): WriterAnswer | undefined => {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return undefined;
    if (parsed['kind'] === 'written') return typeof parsed['syncFailure'] === 'string' ? { kind: 'written', syncFailure: parsed['syncFailure'] } : { kind: 'written' };
    const unchanged = parsed['workspaceUnchanged'] === true ? { workspaceUnchanged: true as const } : {};
    if (parsed['kind'] === 'moved' && typeof parsed['expected'] === 'string' && typeof parsed['actual'] === 'string') return { kind: 'moved', expected: parsed['expected'], actual: parsed['actual'], ...unchanged };
    if (parsed['kind'] === 'failed' && typeof parsed['message'] === 'string') return { kind: 'failed', message: parsed['message'], ...unchanged };
    return undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
};

const textOf = async (stream: AsyncIterable<Uint8Array>): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
};

export const writeInWriterChild = async (child: WriterChild, request: WriterRequest): Promise<WriterAnswer> => {
  const stdin = JSON.stringify({ ...request, content: Buffer.from(request.content, 'utf8').toString('base64') });
  const spawned = await child.sandbox.spawn({ argv: child.launch.argv, cwd: child.cwd, env: child.env, stdin }, { ...child.sandboxPolicy, network: 'deny' }, child.signal);
  const [stdout, stderr, exit] = await Promise.all([textOf(spawned.stdout), textOf(spawned.stderr), spawned.exited]);
  const answer = exit.code === 0 ? answerOf(stdout) : undefined;
  if (answer !== undefined) return answer;
  const said = stderr.trim();
  return { kind: 'failed', message: `the file writer ended ${exit.signal === null ? `with exit code ${String(exit.code)}` : `by ${exit.signal}`}${said === '' ? '' : `: ${said}`}` };
};

export const writerChildOf = (ctx: Pick<ToolContext, 'sandbox' | 'sandboxPolicy' | 'writerLaunch' | 'cwd' | 'signal'>): WriterChild => ({
  sandbox: ctx.sandbox,
  sandboxPolicy: ctx.sandboxPolicy,
  launch: ctx.writerLaunch,
  cwd: ctx.cwd,
  env: {},
  signal: ctx.signal,
});
