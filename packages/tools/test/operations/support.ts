import { execFile, spawnSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect } from 'vitest';
import { nodeFileSystem, systemRandom } from '@momonga/foundation';
import type { HelperSelf } from '@momonga/foundation';
import { ToolExecutionError, createOperationTools, nodeShellHost, openGitCredentialChannel } from '@momonga/tools';
import type { AnyTool, ArgvRunner, ForgeAccess, ForgeFetch, OperationSettings, ReconcileContext, ReconcileResult, ToolContext, ToolIdempotencyRecord, ToolResult } from '@momonga/tools';
import { createTempDir, systemTempRoot, testPaths } from '@momonga/testkit';

export const PRODUCT_ENTRY = path.resolve(import.meta.dirname, '..', '..', '..', 'cli', 'src', 'main.ts');

export const ENTRY_AS_SCRIPT: HelperSelf = { execPath: process.execPath, script: PRODUCT_ENTRY };

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

export const onCleanup = (cleanup: () => void | Promise<void>): void => {
  cleanups.push(cleanup);
};

export type GitWorld = {
  base: string;
  home: string;
  work: string;
  bare: string;
  env: Readonly<Record<string, string>>;
  git(cwd: string, ...args: string[]): string;
  gitStatus(cwd: string, ...args: string[]): number;
  write(relative: string, content: string): void;
  commitAll(message: string): string;
  clone(name: string): string;
};

const ZERO = '0'.repeat(40);

export const makeGitWorld = (): GitWorld => {
  const base = createTempDir();
  onCleanup(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const work = path.join(base, 'work');
  const bare = path.join(base, 'remote.git');
  fs.mkdirSync(home, { mode: 0o700 });
  const env: Record<string, string> = {
    HOME: home,
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_AUTHOR_NAME: 'Momonga Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Momonga Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  };
  fs.writeFileSync(env['GIT_CONFIG_GLOBAL'] as string, '[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n', { mode: 0o600 });
  const gitStatus = (cwd: string, ...args: string[]): number => spawnSync('git', args, { cwd, env, encoding: 'utf8' }).status ?? -1;
  const git = (cwd: string, ...args: string[]): string => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  git(base, 'init', '--bare', '--initial-branch=main', bare);
  git(base, 'init', '--initial-branch=main', work);
  git(work, 'remote', 'add', 'origin', bare);
  const write = (relative: string, content: string): void => {
    const file = path.join(work, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const commitAll = (message: string): string => {
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', message);
    return git(work, 'rev-parse', 'HEAD');
  };
  const clone = (name: string): string => {
    const target = path.join(base, name);
    git(base, 'clone', '-q', bare, target);
    return target;
  };
  return { base, home, work, bare, env, git, gitStatus, write, commitAll, clone };
};

export const remoteSha = (world: GitWorld, ref: string): string => {
  const out = world.git(world.base, 'ls-remote', world.bare, `refs/heads/${ref}`);
  return out === '' ? ZERO : (out.split(/\s+/)[0] as string);
};

export const shaOfRemote = (world: GitWorld, remote: string, ref: string): string => {
  const out = world.git(world.base, 'ls-remote', remote, `refs/heads/${ref}`);
  return out === '' ? ZERO : (out.split(/\s+/)[0] as string);
};

export type CountingRunner = { run: ArgvRunner; calls: Array<readonly string[]>; environments: Array<Readonly<Record<string, string>>>; directories: string[]; credentialed: boolean[] };

const execArgv = (argv: readonly string[], cwd: string, env: Readonly<Record<string, string>>, signal: AbortSignal, stdin?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const [file, ...args] = argv;
    const child = execFile(file as string, args, { cwd, env: { ...env }, signal, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (signal.aborted) {
        reject(new ToolExecutionError(`${argv.slice(0, 2).join(' ')} was cancelled or ran out of time`));
        return;
      }
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      resolve({ exitCode: code, stdout, stderr });
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(stdin ?? '');
  });

export const countingRunner = (): CountingRunner => {
  const calls: Array<readonly string[]> = [];
  const environments: Array<Readonly<Record<string, string>>> = [];
  const directories: string[] = [];
  const credentialed: boolean[] = [];
  const run: ArgvRunner = async (argv, options) => {
    calls.push([...argv]);
    directories.push(options.cwd);
    const credentials = options.credentials ?? [];
    credentialed.push(credentials.length > 0);
    if (credentials.length === 0) {
      environments.push(options.env);
      return execArgv(argv, options.cwd, options.env, options.signal, options.stdin);
    }
    const channel = await openGitCredentialChannel(credentials, { root: systemTempRoot(), random: systemRandom, files: nodeFileSystem, helper: ENTRY_AS_SCRIPT });
    try {
      const env = channel.environment(options.env);
      environments.push(env);
      const result = await execArgv(argv, options.cwd, env, options.signal, options.stdin);
      return { exitCode: result.exitCode, stdout: channel.redact(result.stdout), stderr: channel.redact(result.stderr) };
    } finally {
      await channel.close();
    }
  };
  return { run, calls, environments, directories, credentialed };
};

export const TEST_FETCH: ForgeFetch = (url, { boundMs: _boundMs, ...init }) => fetch(url, init);

export const NO_FORGE: ForgeAccess = {
  request: async () => {
    throw new Error('this test configures no forge');
  },
  gitCredential: async () => undefined,
  gitDestination: () => undefined,
};

export const operationTool = (name: string, deps: { runArgv: ArgvRunner; forge?: ForgeAccess; settings?: OperationSettings; platform?: NodeJS.Platform; shell?: () => Promise<string> }): AnyTool => {
  const tools = createOperationTools({ runArgv: deps.runArgv, forge: deps.forge ?? NO_FORGE, settings: deps.settings ?? {}, platform: deps.platform ?? process.platform, shell: deps.shell ?? (async () => '/bin/sh') });
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no operation tool named ${name}`);
  return tool;
};

export type CallContext = ToolContext;

export const contextFor = (cwd: string, env: Readonly<Record<string, string>>, idemKey = 'k'.repeat(64)): CallContext =>
  ({
    cwd,
    workingDirectory: cwd,
    home: env['HOME'] ?? cwd,
    roots: [cwd],
    runId: 'run-1',
    step: 1,
    callId: 'c1',
    idemKey,
    outputBudgetChars: 100_000,
    env,
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 120_000,
    clock: { now: () => Date.now() },
    shellHost: nodeShellHost(),
    random: systemRandom,
    files: nodeFileSystem,
    session: { cwd, workingDirectory: cwd, readLedger: new Map() },
    attachProcess: () => undefined,
    update: () => undefined,
    checkpoint: () => undefined,
    extendToRunDeadline: () => undefined,
  }) as unknown as CallContext;

export const recordOf = (tool: string, prepared: Record<string, unknown> | undefined, authorisedAt: number | undefined, idemKey = 'k'.repeat(64)): ToolIdempotencyRecord =>
  ({
    key: idemKey,
    state: 'PENDING',
    meta: { tool, ...(prepared === undefined ? {} : { prepared }) },
    createdAt: 1_000,
    expiresAt: Date.now() + 600_000,
    ...(authorisedAt === undefined ? {} : { authorisedAt }),
  }) as ToolIdempotencyRecord;

export const gateFactsFor = (tool: AnyTool, input: unknown, ctx: CallContext): Promise<Record<string, unknown> | undefined> =>
  tool.gateFacts === undefined ? Promise.resolve(undefined) : tool.gateFacts(input, ctx, { signal: ctx.signal, env: ctx.env, context: ctx });

export const subjectFor = async (tool: AnyTool, input: unknown, world: GitWorld): Promise<ReturnType<AnyTool['subject']>> => {
  const ctx = contextFor(world.work, world.env);
  return tool.subject(input, { paths: testPaths(), cwd: world.work, workingDirectory: world.work, home: world.home, roots: [world.work] }, await gateFactsFor(tool, input, ctx));
};

export type CallParts = {
  prepare(gateFacts?: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
  execute(prepared: Record<string, unknown> | undefined): Promise<ToolResult>;
  reconcile(prepared: Record<string, unknown> | undefined, authorisedAt: number | undefined): Promise<ReconcileResult>;
};

export const partsOf = (tool: AnyTool, input: unknown, ctx: CallContext): CallParts => ({
  prepare: async (gateFacts) => (tool.prepare === undefined ? undefined : tool.prepare(input, ctx, gateFacts ?? (await gateFactsFor(tool, input, ctx)))),
  execute: async (prepared) => (await tool.execute(input, ctx, prepared)) as ToolResult,
  reconcile: async (prepared, authorisedAt) => {
    if (tool.reconcile === undefined) throw new Error(`${tool.name} has no reconcile`);
    return tool.reconcile(input, recordOf(tool.name, prepared, authorisedAt, ctx.idemKey), ctx as ReconcileContext);
  },
});

export const expectRejected = (attempt: () => unknown, errorClass: abstract new (...args: never[]) => Error): void => {
  let caught: unknown;
  try {
    attempt();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(errorClass);
};

export type Settled ={ status: 'completed' | 'failed' | 'threw'; output: string };

export const settle = async (work: () => Promise<ToolResult>): Promise<Settled> => {
  try {
    const result = await work();
    return { status: result.status, output: result.output };
  } catch (error) {
    return { status: 'threw', output: error instanceof Error ? error.message : String(error) };
  }
};
