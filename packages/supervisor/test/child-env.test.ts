import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createUserSettingsCache, noKeptRecords } from '@momonga/config';
import { MINIMAL_CHILD_PATH, NETWORK_ENV_NAMES, SECRET_BACKEND_ENV, SECRET_PROGRAM_ENV, secretStoreEnvFor } from '@momonga/foundation';
import { waitFor } from '@momonga/testkit';
import { COLLIDING_CREDENTIAL_DETAIL, definedEnv, gatewayEnv, runtimeEnv } from '../src/child-env.ts';
import type { CredentialSettings } from '../src/child-env.ts';
import { HELD_RETRY_MS } from '../src/constants.ts';
import { errnoError } from './support/p2-fake-spawn-port.ts';
import { createManagerHarness, settingsDeclaring, writeInvalidSettings, writeSettings } from './support/p2-manager-harness.ts';
import { pollUntil } from './support/p2-poll.ts';
import { startSupervisorHarness } from './support/p2-supervisor-harness.ts';

const declaring = (...names: string[]): CredentialSettings =>
  ({
    models: { targets: Object.fromEntries(names.map((name, index) => [`t${index}`, { adapter: 'chat-completions', provider: 'fake', apiKeyEnv: name }])) },
  }) as unknown as CredentialSettings;

const TOKEN_LIKE = 'sk-' + 'placeholder-value';

const configErrorMessage = (home: string): string => {
  const snapshot = createUserSettingsCache({ home, onWarning: () => undefined, keptRecords: noKeptRecords }).snapshot();
  if (!('error' in snapshot)) throw new Error('expected the settings file to be invalid');
  return snapshot.error.message;
};

describe('gatewayEnv', () => {
  it('gateway env has exactly the minimal names, the secret store location and the declared credentials', () => {
    const source = {
      PATH: '/opt/homebrew/bin:/usr/bin',
      HOME: '/Users/u',
      LANG: 'en_US.UTF-8',
      TMPDIR: '/var/tmp/u',
      LC_ALL: 'C',
      UPSTREAM_X: 'upstream-value',
      AWS_SECRET_ACCESS_KEY: 'aws-value',
      FOO: 'foo',
      NODE_OPTIONS: '--require /x.js',
    };
    const env = gatewayEnv(source, declaring('UPSTREAM_X', 'ABSENT_KEY'), '/canonical/home');
    expect(env).toEqual({
      ...secretStoreEnvFor(source),
      PATH: MINIMAL_CHILD_PATH,
      HOME: '/Users/u',
      LANG: 'en_US.UTF-8',
      TMPDIR: '/var/tmp/u',
      LC_ALL: 'C',
      UPSTREAM_X: 'upstream-value',
    });
    expect(env).not.toHaveProperty('ABSENT_KEY');
  });

  it('gatewayEnv carries NODE_EXTRA_CA_CERTS together with the proxy and SSL_CERT_FILE variables', () => {
    const env = gatewayEnv(
      { PATH: '/bin', HOME: '/h', NODE_EXTRA_CA_CERTS: '/etc/corp-ca.pem', HTTPS_PROXY: 'http://proxy:3128', HTTP_PROXY: 'http://proxy:3128', SSL_CERT_FILE: '/etc/ssl.pem' },
      declaring(),
      '/h',
    );
    expect(env['NODE_EXTRA_CA_CERTS']).toBe('/etc/corp-ca.pem');
    expect(env['HTTPS_PROXY']).toBe('http://proxy:3128');
    expect(env['HTTP_PROXY']).toBe('http://proxy:3128');
    expect(env['SSL_CERT_FILE']).toBe('/etc/ssl.pem');
  });

  it('gatewayEnv hands the gateway every network variable the resolver reads', () => {
    const source = Object.fromEntries(NETWORK_ENV_NAMES.map((name) => [name, `value-of-${name}`]));
    const env = gatewayEnv({ PATH: '/bin', HOME: '/h', ...source }, declaring(), '/h');
    for (const name of NETWORK_ENV_NAMES) expect(env[name]).toBe(`value-of-${name}`);
  });

  it('gateway env skips colliding declared names', () => {
    const skipped: string[] = [];
    const source = {
      PATH: 'declared-path-value',
      NODE_OPTIONS: 'declared-node-options',
      LD_PRELOAD: 'declared-ld-preload',
      DYLD_INSERT_LIBRARIES: 'declared-dyld',
      HOME: '/Users/real-home',
      LC_ALL: 'en_US.UTF-8',
    };
    const env = gatewayEnv(
      source,
      declaring('PATH', 'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'HOME', 'LC_ALL'),
      '/canonical/home',
      (name) => skipped.push(name),
    );
    expect(env).toEqual({ ...secretStoreEnvFor(source), PATH: MINIMAL_CHILD_PATH, HOME: '/Users/real-home', LC_ALL: 'en_US.UTF-8' });
    for (const value of ['declared-path-value', 'declared-node-options', 'declared-ld-preload', 'declared-dyld']) expect(Object.values(env)).not.toContain(value);
    expect([...skipped].sort()).toEqual(['DYLD_INSERT_LIBRARIES', 'HOME', 'LC_ALL', 'LD_PRELOAD', 'NODE_OPTIONS', 'PATH']);
  });

  it('gateway HOME comes from the canonical home when the env lacks it', () => {
    expect(gatewayEnv({ PATH: '/bin', LANG: 'C' }, declaring(), '/canonical/home')).toEqual({ ...secretStoreEnvFor({ PATH: '/bin', LANG: 'C' }), PATH: MINIMAL_CHILD_PATH, HOME: '/canonical/home', LANG: 'C' });
  });
});

const referencingSecret = (): CredentialSettings =>
  ({
    models: { targets: { claude: { adapter: 'anthropic', model: 'm', apiKeySecret: 'anthropic-main' } } },
  }) as unknown as CredentialSettings;

const binWith = (program: string): string => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-sup-bin-')));
  fs.writeFileSync(path.join(dir, program), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
  return dir;
};

describe('gatewayEnv secret store discovery', () => {
  it('passes the secret-tool found on the user PATH and the D-Bus address, with the minimal PATH', () => {
    const bin = binWith('secret-tool');
    try {
      const bus = 'unix:path=/nonexistent/momonga-test-bus';
      const env = gatewayEnv({ PATH: bin, HOME: '/home/u', DBUS_SESSION_BUS_ADDRESS: bus, XDG_RUNTIME_DIR: '/run/user/1000' }, referencingSecret(), '/home/u');
      expect(env[SECRET_BACKEND_ENV]).toBe('secret-service');
      expect(env[SECRET_PROGRAM_ENV]).toBe(path.join(bin, 'secret-tool'));
      expect(env['DBUS_SESSION_BUS_ADDRESS']).toBe(bus);
      expect(env['XDG_RUNTIME_DIR']).toBeUndefined();
      expect(env['PATH']).toBe(MINIMAL_CHILD_PATH);
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it('passes no D-Bus address when the chosen store does not declare it', () => {
    const bin = binWith('security');
    try {
      const env = gatewayEnv({ PATH: bin, HOME: '/home/u', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x' }, referencingSecret(), '/home/u');
      expect(env[SECRET_BACKEND_ENV]).toBe('keychain');
      expect(env[SECRET_PROGRAM_ENV]).toBe(path.join(bin, 'security'));
      expect(env['DBUS_SESSION_BUS_ADDRESS']).toBeUndefined();
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it('hands the store location even when no target references a secret', () => {
    const bin = binWith('security');
    try {
      const env = gatewayEnv({ PATH: bin, HOME: '/home/u' }, declaring('UPSTREAM_X'), '/home/u');
      expect(env[SECRET_BACKEND_ENV]).toBe('keychain');
      expect(env[SECRET_PROGRAM_ENV]).toBe(path.join(bin, 'security'));
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe('runtimeEnv', () => {
  it('runtime env keeps neutral names, including a token-shaped value under a neutral name, and removes declared and credential-looking ones', () => {
    const result = runtimeEnv(
      {
        FOO: 'foo',
        PATH: '/opt/bin:/usr/bin',
        UPSTREAM_X: 'upstream-value',
        GITHUB_TOKEN: 'gh-value',
        MY_API_KEY: 'key-value',
        NEUTRAL_NAME: TOKEN_LIKE,
        DATABASE_URL: 'postgres://u:p@h/db',
      },
      declaring('UPSTREAM_X'),
    );
    expect(result.env).toEqual({ FOO: 'foo', PATH: '/opt/bin:/usr/bin', NEUTRAL_NAME: TOKEN_LIKE });
    expect(result.removed).toEqual(['DATABASE_URL', 'GITHUB_TOKEN', 'MY_API_KEY', 'UPSTREAM_X']);
  });
});

describe('undefined values', () => {
  it('undefined env values are dropped', () => {
    const source = { FOO: 'foo', GONE: undefined, PATH: '/bin', HOME: undefined };
    expect(definedEnv(source)).toEqual({ FOO: 'foo', PATH: '/bin' });
    const runtime = runtimeEnv(source, declaring());
    expect(runtime.env).toEqual({ FOO: 'foo', PATH: '/bin' });
    expect(Object.keys(runtime.env)).not.toContain('GONE');
    const gateway = gatewayEnv(source, declaring(), '/h');
    expect(gateway).toEqual({ ...secretStoreEnvFor(definedEnv(source)), PATH: MINIMAL_CHILD_PATH, HOME: '/h' });
    expect(Object.values(gateway)).not.toContain(undefined);
  });
});

describe('settings at every spawn', () => {
  it('snapshot-not-get', async (context) => {
    const harness = createManagerHarness(context);
    harness.spawnInitial();
    harness.port.last().exit(1);
    await waitFor(() => harness.manager.state() === 'backoff');
    harness.timers.advance(250);
    expect(harness.spawnCount()).toBe(2);
    writeInvalidSettings(harness.home);
    harness.port.last().exit(1);
    await waitFor(() => harness.manager.state() === 'backoff');
    harness.timers.advance(500);
    await waitFor(() => harness.manager.state() === 'held-config');
    expect(harness.spawnCount()).toBe(2);
    expect(harness.settings.getCalls).toBe(0);
    expect(harness.settings.snapshotCalls).toBe(3);
  });

  it('a respawn uses a fresh snapshot', async (context) => {
    for (const role of ['runtime', 'gateway'] as const) {
      const harness = createManagerHarness(context, { role, env: { PATH: '/bin', HOME: '/h', UPSTREAM_X: 'upstream-value' } });
      harness.spawnInitial();
      expect(harness.port.last().options.env['UPSTREAM_X']).toBe(role === 'runtime' ? 'upstream-value' : undefined);
      writeSettings(harness.home, settingsDeclaring('UPSTREAM_X'));
      harness.port.last().exit(1);
      await waitFor(() => harness.manager.state() === 'backoff');
      harness.timers.advance(250);
      expect(harness.spawnCount()).toBe(2);
      expect(harness.port.last().options.env['UPSTREAM_X']).toBe(role === 'runtime' ? undefined : 'upstream-value');
    }
  });

  it('a respawn with an invalid snapshot holds', async (context) => {
    const harness = createManagerHarness(context);
    harness.spawnInitial();
    writeInvalidSettings(harness.home);
    const message = configErrorMessage(harness.home);
    harness.port.last().exit(1);
    await waitFor(() => harness.manager.state() === 'backoff');
    harness.timers.advance(250);
    await waitFor(() => harness.manager.state() === 'held-config');
    expect(harness.spawnCount()).toBe(1);
    expect(harness.manager.health().heldReason).toBe(message);
    expect(harness.events('child.held')).toEqual([expect.objectContaining({ child: 'runtime', source: 'settings', heldReason: message })]);
  });

  it('a respawn with a throwing snapshot backs off', async (context) => {
    const harness = createManagerHarness(context);
    harness.spawnInitial();
    harness.port.last().exit(75);
    await waitFor(() => harness.manager.state() === 'waiting-lock');
    harness.settings.script = () => {
      throw errnoError('EMFILE', 'EMFILE: too many open files');
    };
    harness.timers.advance(500);
    await waitFor(() => harness.manager.state() === 'backoff');
    expect(harness.spawnCount()).toBe(1);
    const health = harness.manager.health();
    expect(health.lastExit).toMatchObject({ code: null, signal: null, reason: 'settings-read-failed' });
    expect(health.consecutiveFailures).toBe(1);
    expect(health.heldReason).toBeUndefined();
    harness.settings.script = undefined;
    harness.timers.advance(249);
    expect(harness.spawnCount()).toBe(1);
    harness.timers.advance(1);
    expect(harness.spawnCount()).toBe(2);
    expect(harness.timers.pending().some((timer) => timer.delayMs === HELD_RETRY_MS)).toBe(false);
  });

  it('a declared name that collides is logged as settings.warning once per name', (context) => {
    const harness = createManagerHarness(context, {
      role: 'gateway',
      settings: settingsDeclaring('PATH', 'NODE_OPTIONS', 'UPSTREAM_X'),
      env: { PATH: '/evil', NODE_OPTIONS: '--evil', UPSTREAM_X: 'u', HOME: '/h' },
    });
    harness.spawnInitial();
    const env = harness.port.last().options.env;
    expect(env['PATH']).toBe(MINIMAL_CHILD_PATH);
    expect(env).not.toHaveProperty('NODE_OPTIONS');
    expect(env['UPSTREAM_X']).toBe('u');
    const warnings = harness.events('settings.warning');
    expect(warnings).toHaveLength(2);
    expect(warnings.map((line) => line['level'])).toEqual(['warn', 'warn']);
    for (const name of ['PATH', 'NODE_OPTIONS']) {
      expect(warnings.some((line) => String(line['detail']).includes(name) && String(line['detail']).includes(COLLIDING_CREDENTIAL_DETAIL))).toBe(true);
    }
  });
});

describe('settings at the supervisor', () => {
  it('invalid settings at start spawns nothing', async (context) => {
    const harness = await startSupervisorHarness(context, { invalidSettings: true });
    const message = configErrorMessage(harness.home);
    await pollUntil(() => harness.supervisor.health().children.every((child) => child.state === 'held-config'), 3000, 'both roles held');
    expect(harness.port.calls).toHaveLength(0);
    const children = harness.supervisor.health().children;
    expect(children.map((child) => child.role)).toEqual(['gateway', 'runtime']);
    for (const child of children) expect(child.heldReason).toBe(message);
    expect(harness.log.events('child.held').map((line) => line['source'])).toEqual(['settings', 'settings']);
  });

  it('the cache warning is neutral and the supervisor states its own policy', async (context) => {
    const harness = await startSupervisorHarness(context, { settings: {} });
    await pollUntil(() => harness.port.calls.length === 2, 3000, 'both roles spawned');
    writeInvalidSettings(harness.home);
    const message = configErrorMessage(harness.home);
    const runtime = harness.port.children.find((child) => child.args[0]?.includes('runtime'));
    expect(runtime).toBeDefined();
    runtime?.exit(1);
    await pollUntil(() => harness.supervisor.health().children.find((child) => child.role === 'runtime')?.state === 'held-config', 3000, 'runtime held');
    const warnings = harness.log.events('settings.warning');
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    for (const warning of warnings) {
      expect(String(warning['detail'])).toMatch(/^settings file is invalid: /);
      expect(String(warning['detail'])).not.toMatch(/keeping|last good/);
      expect(warning).not.toHaveProperty('failClosed');
    }
    expect(harness.log.events('child.held')).toEqual([expect.objectContaining({ child: 'runtime', source: 'settings', heldReason: message })]);
    expect(harness.port.calls).toHaveLength(2);
  });
});
