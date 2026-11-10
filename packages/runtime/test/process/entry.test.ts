import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FIRST_GENERATION, createUdsClient, fixedSocket, inspectProcessLock, momongaPaths } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { startGatewayProcess } from '@momonga/gateway';
import { globalErrorHandler } from '@opentelemetry/core';
import { runRuntimeEntry } from '@momonga/runtime';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeEntryIo, parseJsonLines, registerCleanup, startFakeChatCompletions, startLockHolder, withTempDir, firstGeneration } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import type { FakeEntryIo, JsonLine } from '@momonga/testkit';
import { writeInvalidUserSettings, writeUserSettings } from './helpers.ts';
import { MINIMAL_PATH, clientOf, modelSettings, waitForCondition } from './run-helpers.ts';
import type { RunHome } from './run-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const control = vi.hoisted(() => ({ injectStraggler: false }));

vi.mock('../../src/process/start-runtime-process.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/process/start-runtime-process.ts')>();
  return {
    ...original,
    startRuntimeProcess: async (options: Parameters<typeof original.startRuntimeProcess>[0]) => {
      const handle = await original.startRuntimeProcess(options);
      if (!control.injectStraggler) return handle;
      return {
        ...handle,
        close: async () => {
          const result = await handle.close();
          return { ...result, clean: false, stragglers: [...result.stragglers, 'worker-injected'] };
        },
      };
    },
  };
});

const VERSION = '1.10.0-entry-test';

type Home = { home: string; paths: MomongaPaths; aux: string };

const validHome = (context: CleanupContext): Home => {
  const home = withTempDir(context, { asHome: true });
  const aux = withTempDir(context);
  writeUserSettings(home, { sandbox: 'none', ...modelSettings(path.join(aux, 'up.sock')) });
  return { home, paths: momongaPaths(home, process.platform, {}), aux };
};

const runDir = (paths: MomongaPaths): void => {
  fs.mkdirSync(path.dirname(firstGeneration(paths).locks.runtime), { recursive: true, mode: 0o700 });
};

type Launched = { io: FakeEntryIo; exit: Promise<number> };

const launch = (context: CleanupContext, home: string, flags: readonly string[], ioHome = home): Launched => {
  const io = createFakeEntryIo({ argv: [...flags], home: ioHome, env: { PATH: MINIMAL_PATH, HOME: ioHome } });
  const exit = runRuntimeEntry(io, { version: VERSION });
  registerCleanup(context, async () => {
    if (io.exits.length === 0) io.signal('SIGINT');
    await exit.catch(() => undefined);
  });
  return { io, exit };
};

const waitForReadyOrExit = async ({ io }: Launched): Promise<void> => {
  await waitForCondition(() => io.stdoutLines().length > 0 || io.exits.length > 0, 'the ready line or an exit');
  if (io.exits.length > 0) throw new Error(`the entry exited with ${io.exits[0]} before ready: ${io.stderrLines().join('\n')}`);
};

const stderrJson = (io: FakeEntryIo): JsonLine[] => parseJsonLines(io.stderrLines());

const lastLine = (lines: readonly JsonLine[]): JsonLine | undefined => lines[lines.length - 1];

const roleLog = (io: FakeEntryIo, paths: MomongaPaths): JsonLine[] => parseJsonLines(io.logLines(paths.logFiles.runtime));

describe('runRuntimeEntry exit codes (§5.3, fake EntryIo, real runtime)', () => {
  it('runtime: ConfigError gives 78 with JSON stderr and an entry.exit start-failed line', async (context) => {
    const home = withTempDir(context, { asHome: true });
    fs.mkdirSync(path.join(home, '.momonga'), { recursive: true, mode: 0o700 });
    writeInvalidUserSettings(home);
    const { io, exit } = launch(context, home, [`--home=${home}`, `--generation=${FIRST_GENERATION}`, '--log-target=stderr']);

    expect(await exit).toBe(78);
    expect(io.exits).toEqual([78]);
    expect(io.stdoutText()).toBe('');
    const lines = stderrJson(io);
    expect(lastLine(lines)).toMatchObject({ msg: 'entry.exit', service: 'runtime', code: 78, path: 'start-failed', clean: false });
  });

  it('runtime: a held runtime lock (live pid that started before the lock) gives 75', async (context) => {
    const { home, paths } = validHome(context);
    runDir(paths);
    await startLockHolder(context, firstGeneration(paths).locks.runtime);
    const { io, exit } = launch(context, home, [`--home=${home}`, `--generation=${FIRST_GENERATION}`, '--log-target=stderr']);

    expect(await exit).toBe(75);
    expect(io.stdoutText()).toBe('');
    expect(lastLine(stderrJson(io))).toMatchObject({ msg: 'entry.exit', code: 75, path: 'start-failed', clean: false });
  });

  it('runtime: a held runtime.sock.lock gives 1, not 75', async (context) => {
    const { home, paths } = validHome(context);
    runDir(paths);
    await startLockHolder(context, `${firstGeneration(paths).sockets.runtime}.lock`);
    const { io, exit } = launch(context, home, [`--home=${home}`, `--generation=${FIRST_GENERATION}`, '--log-target=stderr']);

    expect(await exit).toBe(1);
    expect(io.stdoutText()).toBe('');
    expect(lastLine(stderrJson(io))).toMatchObject({ msg: 'entry.exit', code: 1, path: 'start-failed' });
  });

  it('runtime: a lock file left behind by a dead process is no obstacle, and SIGTERM then exits 0', async (context) => {
    const { home, paths } = validHome(context);
    runDir(paths);
    fs.writeFileSync(firstGeneration(paths).locks.runtime, '999999\n', { mode: 0o600 });
    const launched = launch(context, home, [`--home=${home}`, `--generation=${FIRST_GENERATION}`, '--log-target=stderr']);

    await waitForReadyOrExit(launched);
    expect(JSON.parse(launched.io.stdoutLines()[0] ?? '')).toMatchObject({ event: 'ready', service: 'runtime' });
    launched.io.signal('SIGTERM');
    expect(await launched.exit).toBe(0);
  });

  it('runtime: a home given through a symlink still gives 75 (canonical lock path equality)', async (context) => {
    const { home, paths } = validHome(context);
    runDir(paths);
    await startLockHolder(context, firstGeneration(paths).locks.runtime);
    const link = path.join(withTempDir(context), 'h');
    fs.symlinkSync(home, link);
    const { exit } = launch(context, link, [`--home=${link}`, `--generation=${FIRST_GENERATION}`, '--log-target=stderr'], link);

    expect(await exit).toBe(75);
  });

  it('runtime: a clean close gives 0, one stdout line, no lock left, and entry.exit close/sigterm in the role log', async (context) => {
    const { home, paths } = validHome(context);
    const launched = launch(context, home, [`--home=${home}`, `--generation=${FIRST_GENERATION}`, '--log-target=file']);
    await waitForReadyOrExit(launched);

    launched.io.signal('SIGTERM');
    expect(await launched.exit).toBe(0);
    expect(launched.io.exits).toEqual([0]);
    expect(launched.io.stdoutLines()).toHaveLength(1);
    expect(JSON.parse(launched.io.stdoutLines()[0] ?? '')).toMatchObject({ event: 'ready', service: 'runtime', version: VERSION, socketPath: firstGeneration(paths).sockets.runtime });
    expect(await inspectProcessLock(firstGeneration(paths).locks.runtime)).toEqual({ state: 'free' });
    expect(launched.io.logFilePaths).toEqual([paths.logFiles.runtime]);
    const log = roleLog(launched.io, paths);
    expect(log[0]).toMatchObject({ msg: 'entry.start', service: 'runtime' });
    expect(lastLine(log)).toMatchObject({ msg: 'entry.exit', service: 'runtime', code: 0, path: 'close', clean: true, trigger: 'sigterm' });
    expect(launched.io.stderrLines()).toEqual([]);
  });

  it('runtime: a second SIGTERM aborts the drain (drain timeout far beyond the test timeout)', async (context) => {
    const { home, paths, aux } = validHome(context);
    const fake = await startFakeChatCompletions({ scenario: 'tools-ok', socketPath: path.join(aux, 'fake.sock') });
    registerCleanup(context, () => fake.close());
    writeUserSettings(home, { sandbox: 'none', ...modelSettings(fake.socketPath) });
    const gateway = await startGatewayProcess({
      generation: FIRST_GENERATION,
      home,
      env: { PATH: MINIMAL_PATH, HOME: home, TMPDIR: aux },
      version: VERSION,
      stdout: { write: () => true },
    });
    registerCleanup(context, async () => {
      await gateway.close();
    });
    const launched = launch(context, home, [`--home=${home}`, `--generation=${FIRST_GENERATION}`, '--log-target=stderr', '--drain-timeout-ms=600000']);
    await waitForReadyOrExit(launched);
    const project = withTempDir(context);
    const runHome: RunHome = { root: aux, home, paths, project };
    const client = clientOf(runHome);
    const hold = fake.hold();
    registerCleanup(context, () => hold.release());
    const session = await client.createSession();
    await client.createRun(session.id);
    await hold.waitForRequest();

    launched.io.signal('SIGTERM');
    await waitForCondition(() => stderrJson(launched.io).some((line) => line.msg === 'entry.signal'), 'the first signal to be logged');
    launched.io.signal('SIGTERM');

    expect(await launched.exit).toBe(0);
    expect(lastLine(stderrJson(launched.io))).toMatchObject({ msg: 'entry.exit', code: 0, path: 'abort', clean: true, trigger: 'sigterm' });
  });

  it('runtime: a non-clean close (an injected straggler) gives 1', async (context) => {
    control.injectStraggler = true;
    registerCleanup(context, () => {
      control.injectStraggler = false;
    });
    const { home } = validHome(context);
    const launched = launch(context, home, [`--home=${home}`, `--generation=${FIRST_GENERATION}`, '--log-target=stderr']);
    await waitForReadyOrExit(launched);

    launched.io.signal('SIGTERM');
    expect(await launched.exit).toBe(1);
    expect(lastLine(stderrJson(launched.io))).toMatchObject({ msg: 'entry.exit', code: 1, path: 'close', clean: false, trigger: 'sigterm' });
  });

  it('runtime: an unknown flag gives 78 with one JSON line on stderr and no log file', async (context) => {
    const { home } = validHome(context);
    const { io, exit } = launch(context, home, [`--home=${home}`, `--generation=${FIRST_GENERATION}`, '--no-such-flag=1']);

    expect(await exit).toBe(78);
    expect(io.exits).toEqual([78]);
    expect(io.stdoutText()).toBe('');
    expect(io.stderrLines()).toHaveLength(1);
    expect(() => JSON.parse(io.stderrLines()[0] ?? '')).not.toThrow();
    expect(io.stderrLines()[0]).toContain('no-such-flag');
    expect(io.logFilePaths).toEqual([]);
  });

  it('runtime: the OTel error handler is installed and logs otel.error as a warn line on stderr, nothing on stdout', async (context) => {
    const { home } = validHome(context);
    const launched = launch(context, home, [`--home=${home}`, `--generation=${FIRST_GENERATION}`, '--log-target=stderr']);
    await waitForReadyOrExit(launched);

    globalErrorHandler(new Error('otel exporter failed (injected)'));

    const otel = stderrJson(launched.io).filter((line) => line.msg === 'otel.error');
    expect(otel).toHaveLength(1);
    expect(otel[0]).toMatchObject({ level: 'warn', service: 'runtime', err: { message: 'otel exporter failed (injected)' } });
    expect(launched.io.stdoutLines()).toHaveLength(1);
    launched.io.signal('SIGTERM');
    expect(await launched.exit).toBe(0);
  });

  it('runtime: the health route answers while the entry runs without a lifeline', async (context) => {
    const { home, paths } = validHome(context);
    const launched = launch(context, home, [`--home=${home}`, `--generation=${FIRST_GENERATION}`, '--log-target=stderr']);
    await waitForReadyOrExit(launched);
    const client = createUdsClient(fixedSocket(firstGeneration(paths).sockets.runtime));
    registerCleanup(context, () => client.close());

    const response = await client.request({ method: 'GET', path: '/v1/health' });

    expect(response.status).toBe(200);
    expect(launched.io.lifelineFds).toEqual([]);
    expect(launched.io.exits).toEqual([]);
  });
});
