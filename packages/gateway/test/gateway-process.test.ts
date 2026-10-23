import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@momonga/config';
import { FM_SERVE_DEFAULTS, GATEWAY_CONFIG_DEFAULTS } from '@momonga/gateway';
import { FAKE_DETERMINISTIC_REPLY, createFakeClock, createFakeTimers } from '@momonga/testkit';
import { START_MS, expectErrorBody, getJson, outputText, postJson, readJson, userInput } from './gateway-helpers.ts';
import { startFake } from './cc-support.ts';
import {
  PROCESS_VERSION,
  baseEnv,
  captureStdout,
  ccTarget,
  clientFor,
  homePaths,
  launchGateway,
  makeHome,
  spawnSleeper,
  writeSettings,
} from './gateway-process-helpers.ts';

const API_KEY_VALUE = 'momonga-test-api-key';
const body = { model: 'fast', input: userInput('hi') };
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const completions = (fake: Awaited<ReturnType<typeof startFake>>) =>
  fake.requests.filter((request) => request.path === '/v1/chat/completions');

const ccHome = async () => {
  const fake = await startFake({ scenario: 'tools-ok' });
  const home = makeHome();
  writeSettings(home, { models: { aliases: { fast: ['primary'] }, targets: { primary: ccTarget(fake.socketPath) } } });
  return { fake, home };
};

describe('startGatewayProcess', { timeout: 30_000 }, () => {
  it('listens on run/gateway.sock and prints exactly one ready line', async () => {
    const { home } = await ccHome();
    const stdout = captureStdout();
    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION });
    expect(handle.socketPath).toBe(homePaths(home).socket);
    const lines = stdout.lines();
    expect(lines).toHaveLength(1);
    const ready = JSON.parse(lines[0] ?? '');
    expect(Object.keys(ready)).toEqual(['event', 'service', 'pid', 'version', 'socketPath', 'startedAt']);
    expect(ready).toMatchObject({ event: 'ready', service: 'gateway', pid: process.pid, version: PROCESS_VERSION, socketPath: handle.socketPath });

    const health = await getJson(clientFor(handle.socketPath), '/v1/momonga/health');
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ version: PROCESS_VERSION, apiVersion: 1, pid: process.pid, state: 'running', startedAt: ready.startedAt });
  });

  it('takes run/gateway.lock before opening gateway.db, so a second instance fails without touching it', async () => {
    const { home } = await ccHome();
    const paths = homePaths(home);
    fs.mkdirSync(`${paths.root}/run`, { recursive: true, mode: 0o700 });
    const holder = spawnSleeper();
    fs.writeFileSync(paths.lock, `${holder}\n`, { mode: 0o600 });
    await expect(launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION })).rejects.toThrow(String(holder));
    expect(fs.existsSync(paths.db)).toBe(false);
    expect(fs.existsSync(paths.key)).toBe(false);
    expect(fs.readFileSync(paths.lock, 'utf8').trim()).toBe(String(holder));
  });

  it('refuses a second live instance on the same home', async () => {
    const { home } = await ccHome();
    await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION });
    const dbStat = fs.statSync(homePaths(home).db);
    await expect(launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION })).rejects.toThrow(String(process.pid));
    expect(fs.statSync(homePaths(home).db).mtimeMs).toBe(dbStat.mtimeMs);
  });

  it('raises ConfigError for invalid user settings, releases the lock and creates no database', async () => {
    const home = makeHome();
    writeSettings(home, { models: { targets: { '9-bad-name': { adapter: 'fm' } } } });
    const paths = homePaths(home);
    const failure = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ConfigError);
    expect(fs.existsSync(paths.lock)).toBe(false);
    expect(fs.existsSync(paths.db)).toBe(false);
    expect(fs.existsSync(paths.key)).toBe(false);
  });

  it('creates a 32-byte 0600 key file once and reuses it on restart', async () => {
    const { home } = await ccHome();
    const paths = homePaths(home);
    const first = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION });
    const stat = fs.lstatSync(paths.key);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(stat.size).toBe(32);
    const original = fs.readFileSync(paths.key);
    await first.close();
    await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION });
    expect(fs.readFileSync(paths.key).equals(original)).toBe(true);
  });

  it('refuses to start when gateway.db exists but gateway.key is missing', async () => {
    const { home } = await ccHome();
    const paths = homePaths(home);
    const first = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION });
    await first.close();
    fs.rmSync(paths.key);
    await expect(launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION })).rejects.toThrow(
      `gateway.db exists but gateway.key is missing at ${paths.key}; stored compaction items can no longer be verified. Move ${paths.db} aside to start fresh.`,
    );
    expect(fs.existsSync(paths.key)).toBe(false);
    expect(fs.existsSync(paths.lock)).toBe(false);
  });

  it('close() releases the lock and removes the socket, and is idempotent', async () => {
    const { home } = await ccHome();
    const paths = homePaths(home);
    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION });
    expect(fs.existsSync(paths.lock)).toBe(true);
    expect(fs.readFileSync(paths.lock, 'utf8').trim()).toBe(String(process.pid));
    await handle.close();
    expect(fs.existsSync(paths.lock)).toBe(false);
    expect(fs.existsSync(paths.socket)).toBe(false);
    await handle.close();
    const again = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION });
    expect(again.socketPath).toBe(paths.socket);
  });

  it('keeps idempotency entries for the default ttl of 7 days', async () => {
    const { fake, home } = await ccHome();
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION, clock, timers });
    const client = clientFor(handle.socketPath);
    const key = { 'idempotency-key': 'ttl-default' };
    const first = await readJson(await postJson(client, '/v1/responses', body, key));
    expect(first.status).toBe(200);
    clock.advance(SEVEN_DAYS_MS - 1);
    const replayed = await readJson(await postJson(client, '/v1/responses', body, key));
    expect(replayed.body).toEqual(first.body);
    expect(completions(fake)).toHaveLength(1);
    clock.advance(2);
    const fresh = await readJson(await postJson(client, '/v1/responses', body, key));
    expect(fresh.status).toBe(200);
    expect(fresh.body.id).not.toBe(first.body.id);
    expect(completions(fake)).toHaveLength(2);
  });
});

describe('startGatewayProcess credentials', { timeout: 30_000 }, () => {
  it('sends the apiKeyEnv value upstream as a bearer token', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    const home = makeHome();
    writeSettings(home, {
      models: { aliases: { fast: ['primary'] }, targets: { primary: ccTarget(fake.socketPath, { apiKeyEnv: 'MOMONGA_TEST_KEY' }) } },
    });
    const handle = await launchGateway({ home, env: baseEnv(home, { MOMONGA_TEST_KEY: API_KEY_VALUE }), version: PROCESS_VERSION });
    const response = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', body));
    expect(response.status).toBe(200);
    expect(outputText(response.body)).toBe(FAKE_DETERMINISTIC_REPLY);
    expect(completions(fake)).toHaveLength(1);
    expect(completions(fake)[0]?.headers['authorization']).toBe(`Bearer ${API_KEY_VALUE}`);
  });

  it.each([
    ['unset', {}],
    ['empty', { MOMONGA_MISSING_KEY: '' }],
  ])('falls back past a target whose apiKeyEnv is %s, without calling it upstream', async (_label, extraEnv) => {
    const keyed = await startFake({ scenario: 'tools-ok' });
    const backup = await startFake({ scenario: 'tools-ok' });
    const home = makeHome();
    writeSettings(home, {
      models: {
        aliases: { fast: ['keyed', 'backup'] },
        targets: { keyed: ccTarget(keyed.socketPath, { apiKeyEnv: 'MOMONGA_MISSING_KEY' }), backup: ccTarget(backup.socketPath) },
      },
    });
    const handle = await launchGateway({ home, env: baseEnv(home, extraEnv), version: PROCESS_VERSION });
    const response = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', body));
    expect(response.status).toBe(200);
    expect(response.body.momonga.target).toBe('backup');
    expect(response.body.momonga.fallbackFrom).toEqual(['keyed']);
    expect(completions(keyed)).toHaveLength(0);
    expect(completions(backup)).toHaveLength(1);
  });

  it('answers 401 missing_api_key naming the variable in param when no target is left', async () => {
    const keyed = await startFake({ scenario: 'tools-ok' });
    const home = makeHome();
    writeSettings(home, {
      models: { aliases: { fast: ['keyed'] }, targets: { keyed: ccTarget(keyed.socketPath, { apiKeyEnv: 'MOMONGA_MISSING_KEY' }) } },
    });
    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION });
    const response = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', body));
    expect(response.status).toBe(401);
    expectErrorBody(response.body, { type: 'invalid_request', code: 'missing_api_key', param: 'MOMONGA_MISSING_KEY' });
    expect(response.body.error.message).toContain('MOMONGA_MISSING_KEY');
    expect(keyed.requests).toHaveLength(0);
  });

  it('routes each chat-completions target to its own endpoint', async () => {
    const one = await startFake({ scenario: 'tools-ok' });
    const two = await startFake({ scenario: 'tools-ok' });
    const home = makeHome();
    writeSettings(home, {
      models: { aliases: { first: ['one'], second: ['two'] }, targets: { one: ccTarget(one.socketPath), two: ccTarget(two.socketPath) } },
    });
    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION });
    const client = clientFor(handle.socketPath);
    expect((await readJson(await postJson(client, '/v1/responses', { ...body, model: 'second' }))).status).toBe(200);
    expect(completions(one)).toHaveLength(0);
    expect(completions(two)).toHaveLength(1);
    expect((await readJson(await postJson(client, '/v1/responses', { ...body, model: 'first' }))).status).toBe(200);
    expect(completions(one)).toHaveLength(1);
    expect(completions(two)).toHaveLength(1);
  });
});

describe('gateway defaults', () => {
  it('pins the GatewayConfig defaults table', () => {
    expect(GATEWAY_CONFIG_DEFAULTS).toEqual({
      retry: { maxAttempts: 3, baseMs: 500, maxMs: 8000 },
      breaker: { failureThreshold: 5, openMs: 30_000 },
      limits: { maxBodyBytes: 32 * 1024 * 1024, maxIdempotencyFrameBytes: 64 * 1024 * 1024, idempotencyReaderStallMs: 30_000 },
      idempotency: { ttlMs: SEVEN_DAYS_MS },
      closeGraceMs: 10_000,
      sseKeepAliveMs: 15_000,
      detachedMaxMs: 30 * 60 * 1000,
    });
  });

  it('pins the FmServe defaults table', () => {
    expect(FM_SERVE_DEFAULTS).toEqual({
      healthTimeoutMs: 10_000,
      restartBackoffMs: 1000,
      stopGraceMs: 3000,
      maxRestarts: 5,
      restartResetMs: 60_000,
      preconditionTtlMs: 60_000,
    });
  });
});
