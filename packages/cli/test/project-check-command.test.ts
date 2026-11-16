import fs from 'node:fs';
import path from 'node:path';
import { acceptedCheckOf, loadUserSettings } from '@momonga/config';
import { ensureMomongaDirs, momongaPaths } from '@momonga/foundation';
import { describe, expect, it } from 'vitest';
import { projectCheckClear, projectCheckSet, projectCheckShow } from '../src/commands/project-check.ts';
import type { CliPorts } from '../src/ports.ts';
import { UsageError } from '../src/usage-error.ts';
import { freshHome } from './fresh-home.ts';

const setup = async () => {
  const home = freshHome();
  const folder = path.join(home, 'work');
  fs.mkdirSync(folder);
  const canonical = fs.realpathSync(folder);
  const paths = momongaPaths(home, process.platform, {});
  await ensureMomongaDirs(paths);
  const stdout: string[] = [];
  const ports = { home, cwd: folder, interrupt: new AbortController().signal, stdout: { write: (text: string) => (stdout.push(text), true) } } as unknown as CliPorts;
  const stored = async () => acceptedCheckOf((await loadUserSettings({ env: process.env, home, signal: new AbortController().signal })).settings, canonical);
  return { ports, paths, stdout, canonical, stored };
};

describe('momonga project-check', () => {
  it('sets the check of the current folder in the user settings, and shows it', async () => {
    const { ports, paths, stdout, canonical, stored } = await setup();
    expect(await projectCheckSet(ports, paths, 'npm test')).toBe(0);
    expect(await stored()).toEqual({ commands: ['npm test'] });
    stdout.length = 0;
    expect(await projectCheckShow(ports, paths)).toBe(0);
    expect(stdout.join('')).toContain(`${canonical}: npm test`);
  });

  it('clears the check, so the folder has none', async () => {
    const { ports, paths, stdout, canonical, stored } = await setup();
    await projectCheckSet(ports, paths, 'make test');
    expect(await projectCheckClear(ports, paths)).toBe(0);
    expect(await stored()).toBeUndefined();
    stdout.length = 0;
    await projectCheckShow(ports, paths);
    expect(stdout.join('')).toContain(`${canonical}: no check`);
  });

  it('refuses an empty command with the usage exit and stores nothing', async () => {
    const { ports, paths, stored } = await setup();
    await expect(projectCheckSet(ports, paths, '  ')).rejects.toBeInstanceOf(UsageError);
    expect(await stored()).toBeUndefined();
  });
});
