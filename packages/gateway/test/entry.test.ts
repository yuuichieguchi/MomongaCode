import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FIRST_GENERATION, createUdsClient, inspectProcessLock, momongaPaths, fixedSocket } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { GATEWAY_CONFIG_DEFAULTS, runGatewayEntry } from '@momonga/gateway';
import { DAEMON_PROCESS_TEST_TIMEOUT_MS, createFakeEntryIo, parseJsonLines, registerCleanup, startFakeChatCompletions, startLockHolder, withTempDir, firstGeneration } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import type { FakeChatCompletionsServer, FakeEntryIo, JsonLine } from '@momonga/testkit';
import { postJson, readJson, userInput } from './gateway-helpers.ts';
import { MINIMAL_PATH, ccTarget, until, writeSettings } from './gateway-process-helpers.ts';

const PROCESS_TIMEOUT = { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS };
const VERSION = '1.10.0-gateway-entry-test';
const API_KEY_VALUE = 'momonga-test-api-key';

type Home = { home: string; paths: MomongaPaths; fake: FakeChatCompletionsServer };

const validHome = async (context: CleanupContext, target: Record<string, unknown> = {}): Promise<Home> => {
  const aux = withTempDir(context);
  const fake = await startFakeChatCompletions({ scenario: 'tools-ok', socketPath: path.join(aux, 'up.sock') });
  registerCleanup(context, () => fake.close());
  const home = withTempDir(context, { asHome: true });
  writeSettings(home, { models: { aliases: { fast: ['primary'] }, targets: { primary: ccTarget(fake.socketPath, target) } } });
  return { home, paths: momongaPaths(home, process.platform, {}), fake };
};

const runDir = (paths: MomongaPaths): void => {
  fs.mkdirSync(path.dirname(firstGeneration(paths).locks.gateway), { recursive: true, mode: 0o700 });
};

type Launched = { io: FakeEntryIo; exit: Promise<number> };

const launch = (context: CleanupContext, home: string, flags: readonly string[], env: Record<string, string> = {}, ioHome = home): Launched => {
  const io = createFakeEntryIo({ argv: [...flags], home: ioHome, env: { PATH: MINIMAL_PATH, HOME: ioHome, ...env } });
  const exit = runGatewayEntry(io, { version: VERSION });
  registerCleanup(context, async () => {
    if (io.exits.length === 0) io.signal('SIGINT');
    await exit.catch(() => undefined);
  });
  return { io, exit };
};

const waitForReadyOrExit = async ({ io }: Launched): Promise<void> => {
  await until(() => io.stdoutLines().length > 0 || io.exits.length > 0, 'the ready line or an exit', 30_000);
  if (io.exits.length > 0) throw new Error(`the entry exited with ${io.exits[0]} before ready: ${io.stderrLines().join('\n')}`);
};

const stderrJson = (io: FakeEntryIo): JsonLine[] => parseJsonLines(io.stderrLines());

const lastLine = (lines: readonly JsonLine[]): JsonLine | undefined => lines[lines.length - 1];

describe('runGatewayEntry exit codes (§5.2, §5.3, fake EntryIo, real gateway)', () => {
  it('gateway: invalid settings give 78 and an entry.exit start-failed line', PROCESS_TIMEOUT, async (context) => {
    const home = withTempDir(context, { asHome: true });
    writeSettings(home, { models: { targets: { '9-bad-name': { adapter: 'managed', server: 'fm' } } } });
    const { io, exit } = launch(context, home, [`--home=${home}`, `--generation=${FIRST_GENERATION}`, '--log-target=stderr']);

    expect(await exit).toBe(78);
    expect(io.exits).toEqual([78]);
    expect(io.stdoutText()).toBe('');
    expect(lastLine(stderrJson(io))).toMatchObject({ msg: 'entry.exit', service: 'gateway', code: 78, path: 'start-failed', clean: false });
  });

  it('gateway: a held gateway.lock gives 75', PROCESS_TIMEOUT, async (context) => {
    const { home, paths } = await validHome(context);
    runDir(paths);
    await startLockHolder(context, firstGeneration(paths).locks.gateway);
    const { io, exit } = launch(context, home, [`--home=${home}`, `--generation=${FIRST_GENERATION}`, '--log-target=stderr']);

    expect(await exit).toBe(75);
    expect(io.stdoutText()).toBe('');
  });

  it('gateway: a held gateway.sock.lock gives 1', PROCESS_TIMEOUT, async (context) => {
    const { home, paths } = await validHome(context);
    runDir(paths);
    await startLockHolder(context, `${firstGeneration(paths).sockets.gateway}.lock`);
    const { io, exit } = launch(context, home, [`--home=${home}`, `--generation=${FIRST_GENERATION}`, '--log-target=stderr']);

    expect(await exit).toBe(1);
    expect(io.stdoutText()).toBe('');
  });

  it('gateway: a lock file left behind by a dead process is no obstacle, and SIGTERM then exits 0', PROCESS_TIMEOUT, async (context) => {
    const { home, paths } = await validHome(context);
    runDir(paths);
    fs.writeFileSync(firstGeneration(paths).locks.gateway, '999999\n', { mode: 0o600 });
    const launched = launch(context, home, [`--home=${home}`, `--generation=${FIRST_GENERATION}`, '--log-target=stderr']);

    await waitForReadyOrExit(launched);
    expect(JSON.parse(launched.io.stdoutLines()[0] ?? '')).toMatchObject({ event: 'ready', service: 'gateway' });
    launched.io.signal('SIGTERM');
    expect(await launched.exit).toBe(0);
  });

  it('gateway: a home given through a symlink still gives 75 (the entry canonicalises the home)', PROCESS_TIMEOUT, async (context) => {
    const { home, paths } = await validHome(context);
    runDir(paths);
    await startLockHolder(context, firstGeneration(paths).locks.gateway);
    const link = path.join(withTempDir(context), 'h');
    fs.symlinkSync(home, link);
    const { exit } = launch(context, link, [`--home=${link}`, `--generation=${FIRST_GENERATION}`, '--log-target=stderr'], {}, link);

    expect(await exit).toBe(75);
  });

  it('gateway: a clean close gives 0, one stdout line, no lock left, entry.exit close/sigterm in the role log', PROCESS_TIMEOUT, async (context) => {
    const { home, paths } = await validHome(context);
    const launched = launch(context, home, [`--home=${home}`, `--generation=${FIRST_GENERATION}`, '--log-target=file']);
    await waitForReadyOrExit(launched);

    launched.io.signal('SIGTERM');
    expect(await launched.exit).toBe(0);
    expect(launched.io.exits).toEqual([0]);
    expect(launched.io.stdoutLines()).toHaveLength(1);
    expect(JSON.parse(launched.io.stdoutLines()[0] ?? '')).toMatchObject({ event: 'ready', service: 'gateway', version: VERSION, socketPath: firstGeneration(paths).sockets.gateway });
    expect((await inspectProcessLock(firstGeneration(paths).locks.gateway)).state).toBe('free');
    expect(launched.io.logFilePaths).toEqual([paths.logFiles.gateway]);
    const log = parseJsonLines(launched.io.logLines(paths.logFiles.gateway));
    expect(log[0]).toMatchObject({ msg: 'entry.start', service: 'gateway' });
    expect(lastLine(log)).toMatchObject({ msg: 'entry.exit', service: 'gateway', code: 0, path: 'close', clean: true, trigger: 'sigterm' });
    expect(launched.io.stderrLines()).toEqual([]);
  });

  it('gateway: a second SIGTERM aborts and cuts the close grace', PROCESS_TIMEOUT, async (context) => {
    const { home, paths, fake } = await validHome(context);
    const launched = launch(context, home, [`--home=${home}`, `--generation=${FIRST_GENERATION}`, '--log-target=stderr']);
    await waitForReadyOrExit(launched);
    const hold = fake.hold();
    registerCleanup(context, () => hold.release());
    const client = createUdsClient(fixedSocket(firstGeneration(paths).sockets.gateway));
    registerCleanup(context, () => client.close());
    const request = postJson(client, '/v1/responses', { model: 'fast', input: userInput('hold me') }, { 'idempotency-key': 'entry-held' }).catch(() => undefined);
    await hold.waitForRequest();

    launched.io.signal('SIGTERM');
    await until(() => stderrJson(launched.io).some((line) => line.msg === 'entry.signal'), 'the first signal to be logged');
    const secondAt = Date.now();
    launched.io.signal('SIGTERM');

    expect(await launched.exit).toBe(0);
    expect(Date.now() - secondAt).toBeLessThan(GATEWAY_CONFIG_DEFAULTS.closeGraceMs);
    expect(lastLine(stderrJson(launched.io))).toMatchObject({ msg: 'entry.exit', code: 0, path: 'abort', clean: true, trigger: 'sigterm' });
    await request;
  });

  it("gateway: a server 'error' after ready latches fatal, aborts, and exits 1", PROCESS_TIMEOUT, async (context) => {
    const { home } = await validHome(context);
    const servers: http.Server[] = [];
    const createServer = http.createServer.bind(http);
    const spy = vi.spyOn(http, 'createServer').mockImplementation(((...args: Parameters<typeof http.createServer>) => {
      const server = createServer(...args);
      servers.push(server);
      return server;
    }) as typeof http.createServer);
    registerCleanup(context, () => spy.mockRestore());
    const launched = launch(context, home, [`--home=${home}`, `--generation=${FIRST_GENERATION}`, '--log-target=stderr']);
    await waitForReadyOrExit(launched);
    spy.mockRestore();
    const server = servers[0];
    if (server === undefined) throw new Error('the gateway created no http server');

    expect(() => server.emit('error', new Error('server failure after ready (injected)'))).not.toThrow();

    expect(await launched.exit).toBe(1);
    const lines = stderrJson(launched.io);
    expect(lines.some((line) => line.msg === 'entry.fatal')).toBe(true);
    expect(lastLine(lines)).toMatchObject({ msg: 'entry.exit', code: 1, path: 'abort', clean: false, trigger: 'fatal' });
  });

  it('gateway: the env passed to startGatewayProcess is io.env as given (a declared apiKeyEnv reaches upstream)', PROCESS_TIMEOUT, async (context) => {
    const { home, paths, fake } = await validHome(context, { apiKeyEnv: 'MOMONGA_ENTRY_KEY' });
    const launched = launch(context, home, [`--home=${home}`, `--generation=${FIRST_GENERATION}`, '--log-target=stderr'], { MOMONGA_ENTRY_KEY: API_KEY_VALUE });
    await waitForReadyOrExit(launched);
    const client = createUdsClient(fixedSocket(firstGeneration(paths).sockets.gateway));
    registerCleanup(context, () => client.close());

    const response = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi') }));

    expect(response.status).toBe(200);
    const completions = fake.requests.filter((request) => request.path === '/v1/chat/completions');
    expect(completions).toHaveLength(1);
    expect(completions[0]?.headers['authorization']).toBe(`Bearer ${API_KEY_VALUE}`);
  });

  it('gateway: an unknown flag gives 78 with one JSON line on stderr', PROCESS_TIMEOUT, async (context) => {
    const { home } = await validHome(context);
    const { io, exit } = launch(context, home, [`--home=${home}`, `--generation=${FIRST_GENERATION}`, '--no-such-flag']);

    expect(await exit).toBe(78);
    expect(io.stderrLines()).toHaveLength(1);
    expect(() => JSON.parse(io.stderrLines()[0] ?? '')).not.toThrow();
    expect(io.logFilePaths).toEqual([]);
  });
});
