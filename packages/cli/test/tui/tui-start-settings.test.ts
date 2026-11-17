import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTuiStart, setByPerson } from '../../src/tui/tui-start-settings.ts';
import { freshPlace, localFileOf, writeSettings } from './settings-harness.tsx';

const read = (place: ReturnType<typeof freshPlace>) => readTuiStart({ env: {}, home: place.home, projectDir: place.project, userFile: place.userFile, signal: new AbortController().signal, isTrusted: async () => false });

describe('the terminal settings at the start', () => {
  it('are read through the merged loader, with the layer each value came from', async () => {
    const place = freshPlace();
    writeSettings(place.userFile, { tui: { notify: 'bell', screen: 'scrollback' } });
    const local = localFileOf(place);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    writeSettings(local, { tui: { theme: 'light', screen: 'fullscreen' } });
    const start = await read(place);
    if (start.kind !== 'loaded') throw new Error(`expected the settings to load: ${start.message}`);
    expect(start.settings.theme).toBe('light');
    expect(start.settings.notify).toBe('bell');
    expect(start.settings.screen).toBe('scrollback');
    expect(start.sources.theme).toBe('local');
    expect(start.sources.notify).toBe('user');
    expect(start.sources.screen).toBe('user');
    expect(start.sources.mouse).toBe('default');
  });

  it('apply the project layer of a trusted folder at the start, and do not apply it when the folder is not trusted', async () => {
    const place = freshPlace();
    writeSettings(place.projectFile, { tui: { theme: 'light' } });
    const trusted = await readTuiStart({ env: {}, home: place.home, projectDir: place.project, userFile: place.userFile, signal: new AbortController().signal, isTrusted: async () => true });
    if (trusted.kind !== 'loaded') throw new Error('expected the settings to load');
    expect(trusted.settings.theme).toBe('light');
    expect(trusted.sources.theme).toBe('project');
    const untrusted = await readTuiStart({ env: {}, home: place.home, projectDir: place.project, userFile: place.userFile, signal: new AbortController().signal, isTrusted: async () => false });
    if (untrusted.kind !== 'loaded') throw new Error('expected the settings to load');
    expect(untrusted.settings.theme).toBe('auto');
  });

  it('count a stored screen mode as set by the person, even when it is the default value', async () => {
    const place = freshPlace();
    writeSettings(place.userFile, { tui: { screen: 'fullscreen' } });
    const start = await read(place);
    if (start.kind !== 'loaded') throw new Error('expected the settings to load');
    expect(setByPerson(start, 'screen')).toBe(true);
    const fresh = await read(freshPlace());
    if (fresh.kind !== 'loaded') throw new Error('expected the settings to load');
    expect(setByPerson(fresh, 'screen')).toBe(false);
  });

  it('are broken, with the one message of the loader and the file to open, when the user settings file does not load', async () => {
    const place = freshPlace();
    writeSettings(place.userFile, { tui: { screen: 'sideways' } });
    const start = await read(place);
    expect(start).toMatchObject({ kind: 'broken', file: place.userFile });
    if (start.kind !== 'broken') throw new Error('expected a broken start');
    expect(start.message).toContain(place.userFile);
    expect(start.message).toContain('/tui/screen');
  });
});
