import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeSkillFileSystem, createSkillLoader } from '@momonga/skills';

const roots: string[] = [];

const tempRoot = (): string => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-')));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('node skill file system', () => {
  it('answers undefined for an absent directory, an absent file and a path below a file', async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'file'), 'x');
    const system = createNodeSkillFileSystem();
    expect(await system.listDirectory(path.join(root, 'absent'))).toBeUndefined();
    expect(await system.listDirectory(path.join(root, 'file'))).toBeUndefined();
    expect(await system.readText(path.join(root, 'absent'))).toBeUndefined();
    expect(await system.realpath(path.join(root, 'absent'))).toBeUndefined();
  });

  it('rethrows an error that is not an absence', async () => {
    const root = tempRoot();
    const locked = path.join(root, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    try {
      await expect(createNodeSkillFileSystem().listDirectory(locked)).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });

  it('follows symlinks to learn the kind of an entry and treats a broken link as other', async () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'real'));
    fs.writeFileSync(path.join(root, 'real', 'f.txt'), 'x');
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'dir-link'));
    fs.symlinkSync(path.join(root, 'real', 'f.txt'), path.join(root, 'file-link'));
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'broken-link'));
    const entries = await createNodeSkillFileSystem().listDirectory(root);
    expect(Object.fromEntries((entries ?? []).map((entry) => [entry.name, entry.kind]))).toEqual({
      real: 'directory',
      'dir-link': 'directory',
      'file-link': 'file',
      'broken-link': 'other',
    });
  });

  it('loads a skill from a real directory tree through a symlinked skill directory', async () => {
    const root = tempRoot();
    const home = path.join(root, 'home');
    const store = path.join(root, 'store', 'pdf');
    fs.mkdirSync(path.join(store, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(store, 'SKILL.md'), '---\nname: pdf\ndescription: "Use when: PDFs"\n---\nBody\n');
    fs.writeFileSync(path.join(store, 'scripts', 'run.sh'), 'echo');
    fs.mkdirSync(path.join(home, '.agents', 'skills'), { recursive: true });
    fs.symlinkSync(store, path.join(home, '.agents', 'skills', 'pdf'));
    const set = await createSkillLoader({ home, fileSystem: createNodeSkillFileSystem() }).load({ projectRoot: path.join(root, 'project'), trusted: true });
    expect(set.skills).toEqual([expect.objectContaining({ name: 'pdf', directory: path.join(home, '.agents', 'skills', 'pdf'), realDirectory: store })]);
    const { content } = await set.activate('pdf');
    expect(content).toContain('Body');
    expect(content).toContain('<file>scripts/run.sh</file>');
  });
});
