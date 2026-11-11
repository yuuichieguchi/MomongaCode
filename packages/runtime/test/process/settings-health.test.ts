import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@momonga/config';
import { chatTargetSettings, createRun, createSession, makeRuntimeFixture, signalNever, writeInvalidUserSettings, writeJson, writeProjectSettings, writeUserSettings } from './helpers.ts';
import type { RuntimeFixture } from './helpers.ts';

const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
};

const userFileOf = (f: RuntimeFixture): string => path.join(f.temp.home, '.momonga', 'settings.json');
const projectFileOf = (f: RuntimeFixture): string => path.join(f.temp.project, '.momonga', 'settings.json');
const localFileOf = (f: RuntimeFixture): string =>
  path.join(f.temp.home, '.momonga', 'projects', createHash('sha256').update(fs.realpathSync(f.temp.project)).digest('hex'), 'settings.local.json');

const breakFile = (file: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const staging = `${file}.broken.tmp`;
  fs.writeFileSync(staging, '{ "permissions": { "allow": [ ');
  fs.renameSync(staging, file);
};

type Layer = {
  name: string;
  fileOf: (f: RuntimeFixture) => string;
  write: (f: RuntimeFixture, value: unknown) => void;
};

const LAYERS: readonly Layer[] = [
  { name: 'user', fileOf: userFileOf, write: (f, value) => writeUserSettings(f.temp.home, value) },
  { name: 'project', fileOf: projectFileOf, write: (f, value) => writeProjectSettings(f.temp.project, value) },
  { name: 'local', fileOf: localFileOf, write: (f, value) => writeJson(localFileOf(f), value) },
];

const prepared = async (layer: Layer, allow: string): Promise<RuntimeFixture> => {
  const f = await makeRuntimeFixture();
  writeUserSettings(f.temp.home, {});
  f.store.trust.set(f.temp.project, 'trusted');
  layer.write(f, { permissions: { allow: [allow] }, memory: { forgetAfterDays: 30 } });
  return f;
};

const ruleTexts = async (f: RuntimeFixture, session: ReturnType<typeof createSession>): Promise<string[]> =>
  (await f.composition.settings.rules(session)).map((rule) => rule.text);

describe.each(LAYERS)('one rule for the $name settings file (SettingsHealth)', (layer) => {
  it('NoRunFails, ReadsValid: an in-run read after the file broke returns the last good copy and does not throw', async () => {
    const f = await prepared(layer, 'Bash(ls)');
    const session = createSession(f.store, f.temp.project, { env: { PLAIN: '1' } });
    expect(await ruleTexts(f, session)).toEqual(['Bash(ls)']);

    breakFile(layer.fileOf(f));

    expect(await ruleTexts(f, session)).toEqual(['Bash(ls)']);
    expect(await f.composition.settings.hooks(session)).toEqual({});
    expect((await f.composition.settings.memory({ cwd: f.temp.project })).forgetAfterDays).toBe(30);
  });

  it('AdmittedOnlyWhenValid, RefusalNamesFile: admission while the file is broken is refused with a ConfigError naming the file', async () => {
    const f = await prepared(layer, 'Bash(ls)');
    expect((await f.composition.sessionCreateSettings(f.temp.project, signalNever())).additionalDirectories).toEqual([]);

    breakFile(layer.fileOf(f));

    const refusal = await rejectionOf(f.composition.sessionCreateSettings(f.temp.project, signalNever()));
    expect(refusal).toBeInstanceOf(ConfigError);
    expect((refusal as ConfigError).message).toContain(layer.fileOf(f));
    expect((refusal as ConfigError).message).toContain('running runs continue');
  });

  it('ReadsCurrent, FixedThenAdmitted: once the file is valid again, admission passes and in-run reads see the new version', async () => {
    const f = await prepared(layer, 'Bash(ls)');
    const session = createSession(f.store, f.temp.project, { env: { PLAIN: '1' } });
    expect(await ruleTexts(f, session)).toEqual(['Bash(ls)']);
    breakFile(layer.fileOf(f));
    expect(await ruleTexts(f, session)).toEqual(['Bash(ls)']);

    layer.write(f, { permissions: { allow: ['Bash(pwd)'] } });

    expect((await f.composition.sessionCreateSettings(f.temp.project, signalNever())).additionalDirectories).toEqual([]);
    expect(await ruleTexts(f, session)).toEqual(['Bash(pwd)']);
  });
});

describe('the in-run readers of the user file all keep the last good copy (SettingsHealth NoRunFails)', () => {
  it('envFor, the tool runtime and the model readers keep the last good copy after the user file broke', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, { ...chatTargetSettings('UPSTREAM_KEY'), autoMode: { classifier: 'x' } });
    const session = createSession(f.store, f.temp.project, { env: { PLAIN: '1' } });
    const runId = createRun(f.store, session.id);
    await f.cache.load(signalNever());
    expect(f.composition.settings.autoModeClassifier()).toBe('x');

    writeInvalidUserSettings(f.temp.home);
    expect('error' in (await f.cache.load(signalNever()))).toBe(true);

    expect(await f.composition.envFor(session, signalNever())).toEqual({ PLAIN: '1' });
    expect(await f.toolRuntime.port.envFor(session, signalNever())).toEqual({ PLAIN: '1' });
    expect(f.composition.settings.autoModeClassifier()).toBe('x');
    await expect(f.toolRuntime.port.toolSet(runId, { signal: signalNever(), env: Object.freeze({ PLAIN: '1' }) })).resolves.toBeDefined();
  });
});

describe('the memory upkeep pass has no Run and never throws on a broken file (SettingsHealth NoReaderThrows, Sweep)', () => {
  it('reads forgetAfterDays from the last good user copy after the user file broke', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, { memory: { forgetAfterDays: 12 } });
    await f.cache.load(signalNever());
    expect(f.composition.takeUserSnapshot().settings.memory.forgetAfterDays).toBe(12);

    writeInvalidUserSettings(f.temp.home);
    expect('error' in (await f.cache.load(signalNever()))).toBe(true);

    expect(f.composition.takeUserSnapshot().settings.memory.forgetAfterDays).toBe(12);
    expect((await f.composition.settings.memory({ cwd: f.temp.project })).forgetAfterDays).toBe(12);
  });
});
