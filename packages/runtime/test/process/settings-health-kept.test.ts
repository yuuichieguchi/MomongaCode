import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createUserSettingsCache, noKeptRecords } from '@momonga/config';
import * as runtime from '@momonga/runtime';
import { createRun, createSession, makeCache, makeRuntimeFixture, signalNever, writeInvalidUserSettings, writeProjectSettings, writeUserSettings } from './helpers.ts';
import fs from 'node:fs';

const breakProjectFile = (project: string): void => {
  const file = path.join(project, '.momonga', 'settings.json');
  fs.writeFileSync(`${file}.broken.tmp`, '{ "permissions": { "allow": [ ');
  fs.renameSync(`${file}.broken.tmp`, file);
};

describe('the last good copy survives a restart (SettingsHealth Persist, restartUnkept)', () => {
  it('a recovered Run whose project file broke while the runtime was down reads the last good copy', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, {});
    f.store.trust.set(f.temp.project, 'trusted');
    writeProjectSettings(f.temp.project, { permissions: { allow: ['Bash(ls)'] } });
    const session = createSession(f.store, f.temp.project, { env: { PLAIN: '1' } });
    expect((await f.composition.settings.rules(session)).map((rule) => rule.text)).toEqual(['Bash(ls)']);

    breakProjectFile(f.temp.project);
    const restarted = runtime.createSettingsComposition({ home: f.temp.home, cache: makeCache(f.temp.home), store: f.store });

    expect((await restarted.settings.rules(session)).map((rule) => rule.text)).toEqual(['Bash(ls)']);
  });
});

describe('every settings file reports a kept copy the same way: one notice to the Run and one log line', () => {
  const userFile = (home: string): string => path.join(home, '.momonga', 'settings.json');
  const projectFile = (project: string): string => path.join(project, '.momonga', 'settings.json');

  it.each([
    { name: 'user', fileOf: (f: { temp: { home: string; project: string } }) => userFile(f.temp.home), breakIt: (f: { temp: { home: string; project: string } }) => writeInvalidUserSettings(f.temp.home) },
    { name: 'project', fileOf: (f: { temp: { home: string; project: string } }) => projectFile(f.temp.project), breakIt: (f: { temp: { home: string; project: string } }) => breakProjectFile(f.temp.project) },
  ])('the $name file: the tool set of a Run carries the notice that the file is invalid', async ({ fileOf, breakIt }) => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, {});
    f.store.trust.set(f.temp.project, 'trusted');
    writeProjectSettings(f.temp.project, {});
    const session = createSession(f.store, f.temp.project, { env: { PLAIN: '1' } });
    const runId = createRun(f.store, session.id);
    await f.toolRuntime.port.toolSet(runId, { signal: signalNever(), env: Object.freeze({ PLAIN: '1' }) });

    breakIt(f);

    const set = await f.toolRuntime.port.toolSet(runId, { signal: signalNever(), env: Object.freeze({ PLAIN: '1' }) });
    expect(set.notices.filter((notice) => notice.startsWith(`settings file is invalid: ${fileOf(f)}`))).toHaveLength(1);
  });

  it('the project file writes one log line through the same sink as the user file, however many reads keep the copy', async () => {
    const f = await makeRuntimeFixture();
    writeUserSettings(f.temp.home, {});
    f.store.trust.set(f.temp.project, 'trusted');
    writeProjectSettings(f.temp.project, {});
    const warnings: string[] = [];
    const cache = createUserSettingsCache({ home: f.temp.home, onWarning: (warning) => warnings.push(warning), keptRecords: noKeptRecords });
    const composition = runtime.createSettingsComposition({ home: f.temp.home, cache, store: f.store });
    const session = createSession(f.store, f.temp.project, { env: { PLAIN: '1' } });
    await composition.settings.rules(session);

    breakProjectFile(f.temp.project);
    await composition.settings.rules(session);
    await composition.settings.rules(session);

    expect(warnings.filter((warning) => warning.startsWith(`settings file is invalid: ${projectFile(f.temp.project)}`))).toHaveLength(1);
  });
});
