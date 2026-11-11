import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_VERIFICATION_COMMANDS, DEFAULT_VERIFICATION_MANIFESTS } from '@momonga/config';
import { sha256Hex } from '@momonga/foundation';
import * as runtime from '@momonga/runtime';
import type { Session } from '@momonga/store';
import {
  DECLARED_CREDENTIAL,
  chatTargetSettings,
  createRun,
  createSession,
  makeCache,
  makeDir,
  makeRuntimeFixture,
  makeTempHome,
  openStore,
  signalNever,
  writeInvalidUserSettings,
  writeProjectSettings,
  writeUserSettings,
} from './helpers.ts';
import { NEVER_CANCELLED } from '@momonga/testkit';

const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
};

const thrownBy = async (call: () => unknown): Promise<unknown> => {
  try {
    await call();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
};

describe('settings composition hooks and auto mode', () => {
  const stopHook = (command: string) => ({ Stop: [{ hooks: [{ type: 'command', command }] }] });

  it('serves project hooks only once the folder is trusted and always serves the user classifier', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, { ...chatTargetSettings(DECLARED_CREDENTIAL), hooks: stopHook('user-stop'), autoMode: { classifier: 'x' } });
    writeProjectSettings(f.temp.project, { hooks: stopHook('project-stop'), autoMode: { classifier: 'attacker' } });
    const session = createSession(f.store, f.temp.project);

    expect((await f.composition.settings.hooks(session)).Stop?.map((group) => group.hooks[0]?.command)).toEqual(['user-stop']);
    f.store.trust.set(f.temp.project, 'trusted');
    expect((await f.composition.settings.hooks(session)).Stop?.map((group) => group.hooks[0]?.command)).toEqual(['user-stop', 'project-stop']);
    expect(f.composition.settings.autoModeClassifier()).toBe('x');
    expect((await f.composition.sessionCreateSettings(f.temp.project, signalNever())).autoModeClassifier).toBe('fake/x');
  });

  it('serves the verification commands of the layers, the defaults when no layer names any', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, {});
    const session = createSession(f.store, f.temp.project);
    expect((await f.composition.settings.verification(session)).commands).toEqual([...DEFAULT_VERIFICATION_COMMANDS]);

    writeUserSettings(f.temp.home, { verification: { commands: ['make check'] } });
    expect(await f.composition.settings.verification(session)).toEqual({
      commands: ['make check'],
      manifests: [...DEFAULT_VERIFICATION_MANIFESTS],
      conditions: ['make check'],
      required: false,
    });
  });

  it('reads the classifier key on the OS the composition is given, not the host it runs on', async () => {
    const f = await makeRuntimeFixture();
    const binary = path.join(makeDir(f.temp.home, 'bin'), 'fm');
    fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeUserSettings(f.temp.home, { autoMode: { classifier: 'system' }, models: { connections: [{ adapter: 'managed', server: 'fm', binary, models: [{ id: 'system', toolCalling: 'native' }] }] } });
    const composition = runtime.createSettingsComposition({ signal: new AbortController().signal, home: f.temp.home, platform: 'aix', cache: makeCache(f.temp.home), store: f.store });
    const created = await composition.sessionCreateSettings(f.temp.project, signalNever());
    expect(created.autoModeClassifier).toBe('apple/system');
    expect(created.autoModeKey).toBeUndefined();
  });

  it('reports no classifier when the user settings name none', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, {});
    expect(f.composition.settings.autoModeClassifier()).toBeUndefined();
  });
});

describe('settings composition (fake timers, not used by the code under test)', () => {
  it('takeUserSnapshot returns the latest result and keeps the last good copy once the file is broken', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, { permissions: { defaultMode: 'acceptEdits' } });

    const snapshot = f.composition.takeUserSnapshot();
    expect(snapshot.settings.permissions.defaultMode).toBe('acceptEdits');
    expect(snapshot.user.layer?.origin).toBe('user');

    writeUserSettings(f.temp.home, { permissions: { defaultMode: 'plan' } });
    expect(f.composition.takeUserSnapshot().settings.permissions.defaultMode).toBe('plan');

    writeInvalidUserSettings(f.temp.home);
    expect(f.composition.takeUserSnapshot().settings.permissions.defaultMode).toBe('plan');
  });

  it('sessionCreateSettings takes one snapshot and returns the mode, origin, directories and credential names', async () => {
    const f = await makeRuntimeFixture();
    const extra = makeDir(f.temp.root, 'extra');
    writeUserSettings(f.temp.home, { ...chatTargetSettings(DECLARED_CREDENTIAL), permissions: { defaultMode: 'acceptEdits', additionalDirectories: [extra] } });
    const before = f.cache.snapshots;

    const result = await f.composition.sessionCreateSettings(f.temp.project, signalNever());

    expect(f.cache.snapshots - before).toBe(1);
    expect(result).toEqual({
      defaultMode: 'acceptEdits',
      defaultModeOrigin: 'user',
      additionalDirectories: [extra],
      credentialEnvNames: [DECLARED_CREDENTIAL],
    });
  });

  it('sessionCreateSettings omits an absent mode and origin, so a cli origin can never be reported', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, {});

    const result = await f.composition.sessionCreateSettings(f.temp.project, signalNever());

    expect(result).toEqual({ additionalDirectories: [], credentialEnvNames: [] });
    expect(Object.hasOwn(result, 'defaultMode')).toBe(false);
    expect(Object.hasOwn(result, 'defaultModeOrigin')).toBe(false);
  });

  it('sessionCreateSettings reports a project origin for a trusted project mode', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, { permissions: { defaultMode: 'acceptEdits' } });
    writeProjectSettings(f.temp.project, { permissions: { defaultMode: 'plan' } });
    f.store.trust.set(f.temp.project, 'trusted');

    const result = await f.composition.sessionCreateSettings(f.temp.project, signalNever());

    expect(result.defaultMode).toBe('plan');
    expect(result.defaultModeOrigin).toBe('project');
  });

  it('when the user settings file is invalid before any valid copy was read, sessionCreateSettings, settings.rules, envFor and toolSet throw ConfigError', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, {});
    const session = createSession(f.store, f.temp.project, { env: { PLAIN: '1' } });
    const runId = createRun(f.store, session.id);
    writeInvalidUserSettings(f.temp.home);

    expect(await rejectionOf(f.composition.sessionCreateSettings(f.temp.project, signalNever()))).toBeInstanceOf(ConfigError);
    expect(await rejectionOf(f.composition.settings.rules(session))).toBeInstanceOf(ConfigError);
    expect(await thrownBy(() => f.composition.envFor(session))).toBeInstanceOf(ConfigError);
    expect(await thrownBy(() => f.toolRuntime.port.envFor(session))).toBeInstanceOf(ConfigError);
    expect(await rejectionOf(f.toolRuntime.port.toolSet(runId, { signal: signalNever(), env: Object.freeze({ PLAIN: '1' }) }))).toBeInstanceOf(ConfigError);
  });

  it('after the file becomes invalid, no credential names are guessed: sessionCreateSettings fails and a running session keeps the last good credential names', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, chatTargetSettings(DECLARED_CREDENTIAL));
    const session = createSession(f.store, f.temp.project, { env: { [DECLARED_CREDENTIAL]: 'v', PLAIN: '1' } });
    expect(await f.composition.sessionCreateSettings(f.temp.project, signalNever())).toMatchObject({ credentialEnvNames: [DECLARED_CREDENTIAL] });
    expect(f.composition.envFor(session)).toEqual({ PLAIN: '1' });

    writeInvalidUserSettings(f.temp.home);

    expect(await rejectionOf(f.composition.sessionCreateSettings(f.temp.project, signalNever()))).toBeInstanceOf(ConfigError);
    expect(f.composition.envFor(session)).toEqual({ PLAIN: '1' });
  });

  it('fixing the file restores service without a restart', async () => {
    const f = await makeRuntimeFixture();
    const session = createSession(f.store, f.temp.project, { env: { PLAIN: '1' } });
    writeInvalidUserSettings(f.temp.home);
    expect(await rejectionOf(f.composition.sessionCreateSettings(f.temp.project, signalNever()))).toBeInstanceOf(ConfigError);

    writeUserSettings(f.temp.home, { permissions: { defaultMode: 'acceptEdits', allow: ['Bash(ls)'] } });

    expect(await f.composition.sessionCreateSettings(f.temp.project, signalNever())).toEqual({
      defaultMode: 'acceptEdits',
      defaultModeOrigin: 'user',
      additionalDirectories: [],
      credentialEnvNames: [],
    });
    expect((await f.composition.settings.rules(session)).map((rule) => rule.text)).toEqual(['Bash(ls)']);
    expect(f.composition.envFor(session)).toEqual({ PLAIN: '1' });
  });

  it('a runtime call takes exactly one snapshot', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, { permissions: { allow: ['Bash(ls)'] } });
    const session = createSession(f.store, f.temp.project, { env: { PLAIN: '1' } });
    const runId = createRun(f.store, session.id);
    const delta = async (call: () => unknown): Promise<number> => {
      const before = f.cache.snapshots;
      await call();
      return f.cache.snapshots - before;
    };

    expect(await delta(() => f.composition.sessionCreateSettings(f.temp.project, signalNever()))).toBe(1);
    expect(await delta(() => f.composition.settings.rules(session))).toBe(1);
    expect(await delta(() => f.composition.envFor(session))).toBe(1);
    expect(await delta(() => f.toolRuntime.port.envFor(session))).toBe(1);
    expect(await delta(() => f.toolRuntime.port.toolSet(runId, { signal: signalNever(), env: Object.freeze({ PLAIN: '1' }) }))).toBe(1);
    expect(await delta(() => f.toolRuntime.port.policyFor(session, { signal: NEVER_CANCELLED, env: Object.freeze({ PLAIN: '1' }), rules: [], ruleEnforcement: 'exact-paths' }))).toBe(1);
  });

  it('loadSessionSettings wraps a non-ConfigError as ConfigError with cause', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, {});
    const missing = path.join(f.temp.root, 'missing-project');

    const error = await rejectionOf(f.composition.loadSessionSettings(missing, f.composition.takeUserSnapshot()));

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(((error as Error).cause as NodeJS.ErrnoException).code).toBe('ENOENT');
  });

  it('loadSessionSettings uses the user layer of the snapshot it is given', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, { permissions: { allow: ['Bash(ls)'] } });
    const snapshot = f.composition.takeUserSnapshot();
    writeUserSettings(f.temp.home, { permissions: { allow: ['Bash(pwd)', 'Bash(cat)'] } });

    const loaded = await f.composition.loadSessionSettings(f.temp.project, snapshot);

    expect(loaded.rules.map((rule) => rule.text)).toEqual(['Bash(ls)']);
  });

  it('trusted(session) is synchronous and reflects the store', async () => {
    const f = await makeRuntimeFixture();
    const session = createSession(f.store, f.temp.project);

    const first = f.composition.settings.trusted(session);
    expect(first).toBe(false);
    f.store.trust.set(f.temp.project, 'trusted');
    expect(f.composition.settings.trusted(session)).toBe(true);
    f.store.trust.set(f.temp.project, 'untrusted');
    expect(f.composition.settings.trusted(session)).toBe(false);
    expect(await f.composition.trustOracle.isTrusted(f.temp.project, new AbortController().signal)).toBe(false);
  });

  it('a session in a subdirectory of a trusted project loads project rules', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, {});
    const sub = makeDir(f.temp.project, 'pkg');
    writeProjectSettings(sub, { permissions: { allow: ['Bash(make)'] } });
    const session = createSession(f.store, sub);
    expect(await f.composition.settings.rules(session)).toEqual([]);

    f.store.trust.set(f.temp.project, 'trusted');

    const rules = await f.composition.settings.rules(session);
    expect(rules.map((rule) => [rule.text, rule.origin])).toEqual([['Bash(make)', 'project']]);
    expect(f.composition.settings.trusted(session)).toBe(true);
    expect(await f.composition.trustOracle.isTrusted(sub, new AbortController().signal)).toBe(true);
  });

  it('a decision on home is not inherited', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, {});
    const inside = makeDir(f.temp.home, 'code', 'app');
    writeProjectSettings(inside, { permissions: { allow: ['Bash(make)'] } });
    f.store.trust.set(f.temp.home, 'trusted');
    const session = createSession(f.store, inside);

    expect(await f.composition.trustOracle.isTrusted(inside, new AbortController().signal)).toBe(false);
    expect(f.composition.settings.trusted(session)).toBe(false);
    expect(await f.composition.settings.rules(session)).toEqual([]);
  });

  it("appendRule writes to the project's local settings", async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, {});
    const session = createSession(f.store, f.temp.project);

    await f.composition.settings.appendRule(session, { effect: 'allow', rule: 'Bash(npm test)' }, signalNever());

    const file = path.join(f.temp.home, '.momonga', 'projects', sha256Hex(fs.realpathSync.native(f.temp.project)), 'settings.local.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ permissions: { allow: ['Bash(npm test)'] } });
    const rules = await f.composition.settings.rules(session);
    expect(rules.map((rule) => [rule.text, rule.origin, rule.effect])).toEqual([['Bash(npm test)', 'local', 'allow']]);
  });

  it('envFor strips credentials declared after session create, at use time', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, {});
    const session = createSession(f.store, f.temp.project, { env: { [DECLARED_CREDENTIAL]: 'v', PLAIN: '1' } });
    expect(f.composition.envFor(session)).toEqual({ [DECLARED_CREDENTIAL]: 'v', PLAIN: '1' });

    writeUserSettings(f.temp.home, chatTargetSettings(DECLARED_CREDENTIAL));

    expect(f.composition.envFor(session)).toEqual({ PLAIN: '1' });
    expect(f.toolRuntime.port.envFor(session)).toEqual({ PLAIN: '1' });
    expect(session.env).toEqual({ [DECLARED_CREDENTIAL]: 'v', PLAIN: '1' });
  });

  it('envFor returns a frozen object and a mutation attempt throws in strict mode', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, {});
    const session: Session = createSession(f.store, f.temp.project, { env: { PLAIN: '1' } });

    const env = f.composition.envFor(session) as Record<string, string>;

    expect(Object.isFrozen(env)).toBe(true);
    await expect((async () => {
      env['PLAIN'] = '2';
    })()).rejects.toThrow(TypeError);
    await expect((async () => {
      env['ADDED'] = '1';
    })()).rejects.toThrow(TypeError);
    expect(env).toEqual({ PLAIN: '1' });
  });

  it('a relative home raises TypeError', async () => {
    const temp = await makeTempHome();
    const { store } = openStore(temp);

    const error = await thrownBy(() => runtime.createSettingsComposition({ signal: new AbortController().signal, home: 'relative/home', platform: process.platform, cache: makeCache(temp.home), store }));

    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toContain('relative/home');
  });
});
