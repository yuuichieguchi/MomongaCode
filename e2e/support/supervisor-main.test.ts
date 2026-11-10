import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BASE_ENTRY_FLAGS, EntryUsageError, parseFlags } from '@momonga/foundation';
import { productTestEnv, registerCleanup, spawnProduct, startFakeChatCompletions, testHostPath, withTempDir } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { STDERR_FLOOD_BYTES } from './fixtures/stderr-flood-supervisor.ts';
import type { StackParentReport, StackParentRequest } from './fixtures/stack-parent.ts';
import { createE2eHome, registerE2eCleanup } from './home.ts';
import { supervisorLog } from './log-reader.ts';
import { isAlive } from './process.ts';
import { E2E_RUN_ENV, e2eTmpRoot } from './run-env.ts';
import { resolveSandbox } from './sandbox.ts';
import {
  DEFAULT_E2E_DEPS,
  STDERR_TAIL_BYTES,
  SUPERVISOR_ENV_PATH,
  SUPERVISOR_MAIN_PATH,
  baseSettings,
  spawnSupervisor,
  startStack,
  supervisorArgv,
  supervisorEnv,
  writeDepsFile,
  writeSettingsFile,
} from './stack.ts';
import { createSupervisorClient } from './supervisor-client.ts';
import { E2E_DEPS_ENV, guardSupervisorHome } from './supervisor-main.ts';
import { E2E_READY_DEADLINE_MS, E2E_SUPERVISOR_CLOSE_BOUND_MS, E2E_TEST_TIMEOUT_MS, e2eTestTimeoutMs, until, withinBound } from './wait.ts';

const PARENT_KILLED_TIMEOUT_MS = e2eTestTimeoutMs(E2E_READY_DEADLINE_MS, E2E_READY_DEADLINE_MS, E2E_SUPERVISOR_CLOSE_BOUND_MS);

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const STDERR_FLOOD_PATH = path.join(FIXTURES, 'stderr-flood-supervisor.ts');
const STACK_PARENT_PATH = path.join(FIXTURES, 'stack-parent.ts');

type ScriptResult = { code: number | null; stderr: string };

const runToken = (): string => {
  const run = process.env[E2E_RUN_ENV];
  if (run === undefined) throw new Error(`${E2E_RUN_ENV} is not set; the e2e global setup did not run`);
  return run;
};

const runMain = (context: CleanupContext, home: string, env: Record<string, string>, homeFlag: string = home): Promise<ScriptResult> => {
  const child = spawnProduct(context, process.execPath, [SUPERVISOR_MAIN_PATH, `--home=${homeFlag}`, '--log-target=file'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.stdout?.resume();
  return withinBound(once(child, 'close'), E2E_SUPERVISOR_CLOSE_BOUND_MS, 'supervisor-main exit').then(
    ([code]: unknown[]) => ({ code: typeof code === 'number' ? code : null, stderr }),
    (error: unknown) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; stderr: ${stderr}`, { cause: error });
    },
  );
};

const manualE2eRoot = (context: CleanupContext): string => {
  const root = fs.mkdtempSync(path.join(e2eTmpRoot(), `mme-${runToken()}-`));
  registerCleanup(context, () => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
};

const guardEnv = (home: string, overrides: Record<string, string> = {}): Record<string, string> =>
  productTestEnv({
    PATH: SUPERVISOR_ENV_PATH,
    HOME: home,
    TMPDIR: home,
    LANG: 'C',
    [E2E_RUN_ENV]: runToken(),
    [E2E_DEPS_ENV]: path.join(home, 'deps-missing.json'),
    ...overrides,
  });

const firstLine = async (stream: NodeJS.ReadableStream): Promise<string> => {
  const lines = readline.createInterface({ input: stream });
  try {
    for await (const line of lines) return line;
    throw new Error('stream ended before the first line');
  } finally {
    lines.close();
  }
};

describe('supervisor-main guard', () => {
  it('exits 1 for a run token that is not 4 lowercase hex characters, before touching the home or the deps', async (context) => {
    const home = manualE2eRoot(context);
    const result = await runMain(context, home, guardEnv(home, { [E2E_RUN_ENV]: 'ZZZZ' }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(E2E_RUN_ENV);
    expect(result.stderr).not.toContain('deps-missing.json');
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it('exits 1 for a HOME whose basename is not mme-<run>-<6>', async (context) => {
    const home = withTempDir(context);
    const result = await runMain(context, home, guardEnv(home));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('HOME');
    expect(result.stderr).not.toContain('deps-missing.json');
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it('exits 1 when HOME and TMPDIR differ', async (context) => {
    const home = manualE2eRoot(context);
    const other = withTempDir(context);
    const result = await runMain(context, home, guardEnv(home, { TMPDIR: other }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('TMPDIR');
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it('exits 1 naming an unknown deps key, before starting a supervisor', async (context) => {
    const home = manualE2eRoot(context);
    const depsFile = path.join(home, 'deps-1.json');
    fs.writeFileSync(depsFile, JSON.stringify({ runtime: { leaseMs: 3000 }, leaseMz: 3000 }), { mode: 0o600 });
    const result = await runMain(context, home, guardEnv(home, { [E2E_DEPS_ENV]: depsFile }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('leaseMz');
    expect(fs.readdirSync(home)).toEqual(['deps-1.json']);
  });

  it('exits 1 naming --home when --home is not the guarded HOME, before touching either directory', async (context) => {
    const home = manualE2eRoot(context);
    const other = withTempDir(context);
    const result = await runMain(context, home, guardEnv(home), other);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--home');
    expect(result.stderr).not.toContain('deps-missing.json');
    expect(fs.readdirSync(home)).toEqual([]);
    expect(fs.readdirSync(other)).toEqual([]);
  });

  it('guardSupervisorHome refuses an argv without --home and one whose --home resolves elsewhere, and accepts the guarded HOME', (context) => {
    const home = manualE2eRoot(context);
    const other = withTempDir(context);
    const input = { env: guardEnv(home), userHome: os.userInfo().homedir };
    expect(guardSupervisorHome([], input)).toEqual(expect.stringContaining('--home'));
    expect(guardSupervisorHome([`--home=${other}`], input)).toEqual(expect.stringContaining('--home'));
    expect(guardSupervisorHome([`--home=${home}`, '--log-target=file'], input)).toBeUndefined();
  });
});

describe('supervisor argv and env', () => {
  it('is exactly the BASE_ENTRY_FLAGS set, and a lifeline flag is refused', async () => {
    const home = await createE2eHome();
    const argv = supervisorArgv(home);
    expect(parseFlags(argv, BASE_ENTRY_FLAGS)).toEqual({ home: home.home, 'log-target': 'file' });
    expect(() => parseFlags([...argv, '--lifeline-fd=3'], BASE_ENTRY_FLAGS)).toThrow(EntryUsageError);
  });

  it('is an explicit minimal env that never inherits process.env', async () => {
    const home = await createE2eHome();
    const depsFile = path.join(home.root, 'deps-1.json');
    expect(supervisorEnv(home, depsFile)).toEqual({
      PATH: testHostPath('/usr/bin:/bin:/usr/sbin:/sbin'),
      HOME: home.home,
      TMPDIR: home.root,
      LANG: 'C',
      MOMONGA_E2E_RUN: home.run,
      MOMONGA_E2E_DEPS: depsFile,
    });
  });
});

describe('supervisor-main lifeline and pipes', () => {
  it('drains both pipes and ends the supervisor with sigterm when its stdin reaches EOF', { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const stack = await startStack({ home });
    expect(stack.supervisor.child.stdout.listenerCount('data')).toBeGreaterThan(0);
    expect(stack.supervisor.child.stderr.listenerCount('data')).toBeGreaterThan(0);
    stack.supervisor.child.stdin.end();
    const exit = await withinBound(stack.supervisor.exited, E2E_SUPERVISOR_CLOSE_BOUND_MS, 'supervisor exit after stdin EOF');
    expect(exit).toEqual({ code: 0, signal: null });
    const last = supervisorLog(home.paths, stack.ready.pid).at(-1);
    expect(last).toMatchObject({ msg: 'entry.exit', trigger: 'sigterm', path: 'close', clean: true });
  });

  it('a supervisor that writes more than 64 KiB to stderr is not blocked', { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    expect(STDERR_FLOOD_BYTES).toBeGreaterThan(64 * 1024);
    const supervisor = spawnSupervisor({ home, deps: DEFAULT_E2E_DEPS, script: STDERR_FLOOD_PATH });
    const ready = await supervisor.ready();
    expect(ready).toMatchObject({ service: 'supervisor', pid: supervisor.pid });
    expect(supervisor.stderrTail().length).toBeGreaterThan(0);
    expect(Buffer.byteLength(supervisor.stderrTail())).toBeLessThanOrEqual(STDERR_TAIL_BYTES);
    supervisor.child.stdin.end();
    await expect(withinBound(supervisor.exited, E2E_SUPERVISOR_CLOSE_BOUND_MS, 'flood fixture exit after stdin EOF')).resolves.toEqual({ code: 0, signal: null });
  });

  it('a parent that is SIGKILLed leaves no supervisor and no daemon', { timeout: PARENT_KILLED_TIMEOUT_MS }, async (context) => {
    const home = await createE2eHome();
    const fake = await startFakeChatCompletions({ scenario: 'tools-ok', maxConcurrency: 8, socketPath: home.upstreamSocket });
    registerE2eCleanup(() => fake.close());
    const resolution = resolveSandbox({ needsBash: false });
    writeSettingsFile(home, baseSettings(home, resolution.kind === 'skip' ? 'none' : resolution.kind));
    const depsFile = writeDepsFile(home, DEFAULT_E2E_DEPS, 1);
    const request: StackParentRequest = { args: [SUPERVISOR_MAIN_PATH, ...supervisorArgv(home)], env: supervisorEnv(home, depsFile) };
    const parent = spawnProduct(context, process.execPath, [STACK_PARENT_PATH, JSON.stringify(request)], { stdio: ['ignore', 'pipe', 'ignore'] });
    const report = JSON.parse(await firstLine(parent.stdout as NodeJS.ReadableStream)) as StackParentReport;
    await home.ledger.add(report.supervisorPid, 'supervisor');
    const client = createSupervisorClient(home);
    registerE2eCleanup(() => client.close());
    await client.untilChild('gateway', (child) => child.state === 'ready', E2E_READY_DEADLINE_MS);
    const ready = await client.untilChild('runtime', (child) => child.state === 'ready', E2E_READY_DEADLINE_MS);
    const health = await client.health();
    const daemonPids = health.children.flatMap((child) => (child.pid === undefined ? [] : [child.pid]));
    expect(daemonPids).toHaveLength(2);
    expect(ready.pid).toBeDefined();
    process.kill(parent.pid, 'SIGKILL');
    await until(() => [report.supervisorPid, ...daemonPids].every((pid) => !isAlive(pid)), {
      deadlineMs: E2E_SUPERVISOR_CLOSE_BOUND_MS,
      description: 'supervisor and daemons gone after the parent died',
    });
  });
});
