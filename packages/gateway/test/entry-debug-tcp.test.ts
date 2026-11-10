import { prepareHome } from './gateway-process-helpers.ts';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { request } from 'undici';
import { FIRST_GENERATION, generationLayout, momongaPaths } from '@momonga/foundation';
import { runGatewayEntry } from '@momonga/gateway';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeEntryIo, parseJsonLines, registerCleanup, startFakeChatCompletions, withTempDir } from '@momonga/testkit';
import type { CleanupContext, FakeEntryIo } from '@momonga/testkit';
import { MINIMAL_PATH, ccTarget, until, writeSettings, modelsOf } from './gateway-process-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const VERSION = '1.10.0-debug-tcp-test';
const TOKEN = 'momonga-entry-debug-token';
const launch = async (context: CleanupContext, extraFlags: (home: string, aux: string) => string[]): Promise<{ io: FakeEntryIo; exit: Promise<number>; home: string; aux: string }> => {
  const aux = withTempDir(context);
  const fake = await startFakeChatCompletions({ scenario: 'tools-ok', socketPath: path.join(aux, 'up.sock') });
  registerCleanup(context, () => fake.close());
  const home = withTempDir(context, { asHome: true });
  prepareHome(home);
  writeSettings(home, { models: modelsOf({ primary: ccTarget(fake.socketPath, {}) }) });
  const io = createFakeEntryIo({
    argv: [`--home=${home}`, `--generation=${FIRST_GENERATION}`, '--log-target=stderr', ...extraFlags(home, aux)],
    home,
    env: { PATH: MINIMAL_PATH, HOME: home },
  });
  const exit = runGatewayEntry(io, { version: VERSION });
  registerCleanup(context, async () => {
    if (io.exits.length === 0) io.signal('SIGINT');
    await exit.catch(() => undefined);
  });
  return { io, exit, home, aux };
};

const tokenFile = (aux: string, mode = 0o600, contents = `${TOKEN}\n`): string => {
  const file = path.join(aux, 'debug.token');
  fs.writeFileSync(file, contents, { mode });
  fs.chmodSync(file, mode);
  return file;
};

describe('gateway entry debug listener flags', () => {
  it('opens the loopback listener on the requested port, logs the bound port and demands the token', async (context) => {
    const { io } = await launch(context, (_home, aux) => ['--debug-tcp-port=0', `--debug-tcp-token-file=${tokenFile(aux)}`]);
    await until(() => io.stdoutLines().length > 0 || io.exits.length > 0, 'the ready line or an exit', 30_000);
    expect(io.exits).toEqual([]);
    const listener = parseJsonLines(io.stderrLines()).find((line) => line['msg'] === 'gateway.debug_listener');
    expect(listener).toMatchObject({ level: 'info', host: '127.0.0.1' });
    const port = listener?.['port'] as number;
    expect(port).toBeGreaterThan(0);
    const anonymous = await request(`http://127.0.0.1:${port}/v1/models`);
    expect(anonymous.statusCode).toBe(401);
    await anonymous.body.dump();
    const authorized = await request(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(authorized.statusCode).toBe(200);
    await authorized.body.dump();
  });

  it('opens no TCP listener without the flags', async (context) => {
    const { io, home } = await launch(context, () => []);
    await until(() => io.stdoutLines().length > 0 || io.exits.length > 0, 'the ready line or an exit', 30_000);
    expect(parseJsonLines(io.stderrLines()).some((line) => line['msg'] === 'gateway.debug_listener')).toBe(false);
    expect(fs.existsSync(generationLayout(home, FIRST_GENERATION).sockets.gateway)).toBe(true);
  });

  it.for([
    { name: 'a port without a token file', flags: () => ['--debug-tcp-port=0'] },
    { name: 'a token file without a port', flags: (aux: string) => [`--debug-tcp-token-file=${tokenFile(aux)}`] },
    { name: 'a relative token file', flags: () => ['--debug-tcp-port=0', '--debug-tcp-token-file=relative.token'] },
    { name: 'a token file readable by others', flags: (aux: string) => ['--debug-tcp-port=0', `--debug-tcp-token-file=${tokenFile(aux, 0o644)}`] },
    { name: 'an empty token file', flags: (aux: string) => ['--debug-tcp-port=0', `--debug-tcp-token-file=${tokenFile(aux, 0o600, '\n')}`] },
  ])('exits 78 for $name', async ({ flags }, context) => {
    const { exit, io } = await launch(context, (_home, aux) => flags(aux));
    expect(await exit).toBe(78);
    expect(io.stdoutText()).toBe('');
  });
});
