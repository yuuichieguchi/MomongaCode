import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendPermissionRule, editModelsSettings, editSettings, systemFileLockPorts, writeTuiSetting } from '@momonga/config';
import { localSettingsPath, makeDir, makeTree, userSettingsPath, writeJson } from './helpers.ts';
import type { Tree } from './helpers.ts';
import { testKernelLock } from '@momonga/testkit';

const signal = new AbortController().signal;

const WINDOWS_WITHOUT_LINK_RIGHT = process.platform === 'win32';

type Writer = { name: string; fileOf(tree: Tree): string; write(tree: Tree, file: string): Promise<unknown>; expected: Record<string, unknown> };

const WRITERS: Writer[] = [
  {
    name: 'the settings editor of /config',
    fileOf: userSettingsPath,
    write: (tree) => editSettings({ home: tree.home, projectDir: tree.project }, 'user', { kind: 'set', path: ['autoUpdates'], value: false }, { env: process.env, trusted: true, lock: testKernelLock(), signal }),
    expected: { kept: true, autoUpdates: false },
  },
  {
    name: 'the theme writer',
    fileOf: userSettingsPath,
    write: (tree, file) => writeTuiSetting(tree.home, file, 'theme', 'dark', { lock: testKernelLock(), signal }),
    expected: { kept: true, tui: { theme: 'dark' } },
  },
  {
    name: 'the models writer of /models and of sign-in',
    fileOf: userSettingsPath,
    write: (tree, file) => editModelsSettings(tree.home, file, [{ kind: 'setTimeouts', headersTimeoutMs: 60_000 }], { lock: testKernelLock(), signal }),
    expected: { kept: true, models: { headersTimeoutMs: 60_000 } },
  },
  {
    name: 'the rule writer of "always allow"',
    fileOf: localSettingsPath,
    write: (tree) => appendPermissionRule({ lock: testKernelLock(), ports: systemFileLockPorts, home: tree.home, projectDir: tree.project, rule: 'Bash(npm test)', effect: 'allow', signal }),
    expected: { kept: true, permissions: { allow: ['Bash(npm test)'] } },
  },
];

const linked = (tree: Tree, writer: Writer): { link: string; target: string } => {
  const target = writeJson(path.join(makeDir(), 'dotfiles', 'settings.json'), { kept: true });
  const link = writer.fileOf(tree);
  fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
  fs.symlinkSync(target, link);
  return { link, target };
};

describe.skipIf(WINDOWS_WITHOUT_LINK_RIGHT)('a writer of a settings file that is a symbolic link (skipped on Windows, where creating a link needs a right the test host may lack)', () => {
  it.each(WRITERS)('$name writes the file the link names and leaves the link a link', async (writer) => {
    const tree = makeTree();
    const { link, target } = linked(tree, writer);
    await writer.write(tree, link);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe(target);
    expect(fs.lstatSync(target).isFile()).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(writer.expected);
    expect(fs.readdirSync(path.dirname(link)).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it.each(WRITERS)('$name follows a link to a link to the file', async (writer) => {
    const tree = makeTree();
    const target = writeJson(path.join(makeDir(), 'settings.json'), { kept: true });
    const middle = path.join(makeDir(), 'middle.json');
    fs.symlinkSync(target, middle);
    const link = writer.fileOf(tree);
    fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
    fs.symlinkSync(middle, link);
    await writer.write(tree, link);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(middle).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(writer.expected);
  });

  it.each(WRITERS)('$name refuses a link that names nothing, with the sentence of the reader, and writes nothing', async (writer) => {
    const tree = makeTree();
    const missing = path.join(makeDir(), 'gone.json');
    const link = writer.fileOf(tree);
    fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
    fs.symlinkSync(missing, link);
    await expect(writer.write(tree, link)).rejects.toThrow(`${link}: dangling symlink`);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(missing)).toBe(false);
  });
});

describe('a writer of a settings file that is a regular file', () => {
  it.each(WRITERS)('$name writes that file', async (writer) => {
    const tree = makeTree();
    const file = writeJson(writer.fileOf(tree), { kept: true });
    await writer.write(tree, file);
    expect(fs.lstatSync(file).isFile()).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(writer.expected);
  });
});
