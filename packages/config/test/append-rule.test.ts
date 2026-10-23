import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { appendPermissionRule } from '@momonga/config';
import { localSettingsDir, localSettingsPath, makeDir, makeTree, registerCleanup, writeText } from './helpers.ts';
import type { Tree } from './helpers.ts';

const CONFIG_ENTRY = pathToFileURL(path.resolve(import.meta.dirname, '../src/index.ts')).href;

const readLocal = (tree: Tree): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(localSettingsPath(tree), 'utf8')) as Record<string, unknown>;

describe('appendPermissionRule', () => {
  it('creates settings.local.json with 0600 in a 0700 directory', async () => {
    const tree = makeTree();
    await appendPermissionRule({ home: tree.home, projectDir: tree.project, rule: 'Bash(npm run test:*)', effect: 'allow' });
    const dir = localSettingsDir(tree);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(localSettingsPath(tree)).mode & 0o777).toBe(0o600);
    expect(readLocal(tree)).toEqual({ permissions: { allow: ['Bash(npm run test:*)'] } });
  });

  it('appends without duplicates and preserves other content and key order', async () => {
    const tree = makeTree();
    writeText(
      localSettingsPath(tree),
      JSON.stringify({ zeta: 1, permissions: { deny: ['Read(./secret)'], allow: ['Bash(ls)'] }, alpha: { b: 2, a: 1 } }),
    );
    await appendPermissionRule({ home: tree.home, projectDir: tree.project, rule: 'Bash(ls)', effect: 'allow' });
    await appendPermissionRule({ home: tree.home, projectDir: tree.project, rule: 'Edit(./src/**)', effect: 'allow' });
    await appendPermissionRule({ home: tree.home, projectDir: tree.project, rule: 'Bash(git push:*)', effect: 'ask' });
    const content = readLocal(tree);
    expect(content).toEqual({
      zeta: 1,
      permissions: { deny: ['Read(./secret)'], allow: ['Bash(ls)', 'Edit(./src/**)'], ask: ['Bash(git push:*)'] },
      alpha: { b: 2, a: 1 },
    });
    expect(Object.keys(content)).toEqual(['zeta', 'permissions', 'alpha']);
    expect(Object.keys(content.permissions as object)).toEqual(['deny', 'allow', 'ask']);
    expect(Object.keys(content.alpha as object)).toEqual(['b', 'a']);
  });

  it('rejects an invalid rule without touching the file', async () => {
    const tree = makeTree();
    await expect(appendPermissionRule({ home: tree.home, projectDir: tree.project, rule: 'Bash(oops', effect: 'deny' })).rejects.toThrow('Bash(oops');
    expect(fs.existsSync(localSettingsPath(tree))).toBe(false);
  });

  it('leaves no temp files behind', async () => {
    const tree = makeTree();
    await appendPermissionRule({ home: tree.home, projectDir: tree.project, rule: 'Read', effect: 'allow' });
    expect(fs.readdirSync(localSettingsDir(tree))).toEqual(['settings.local.json']);
  });

  it('does not lose rules under concurrent in-process appends', async () => {
    const tree = makeTree();
    const rules = Array.from({ length: 20 }, (_, i) => `Bash(task${i})`);
    await Promise.all(rules.map((rule) => appendPermissionRule({ home: tree.home, projectDir: tree.project, rule, effect: 'allow' })));
    const allow = (readLocal(tree).permissions as { allow: string[] }).allow;
    expect([...allow].sort()).toEqual([...rules].sort());
  });

  it('does not lose rules under concurrent appends from separate processes', async () => {
    const tree = makeTree();
    const scriptDir = makeDir();
    const script = path.join(scriptDir, 'child.mjs');
    fs.writeFileSync(
      script,
      `const { appendPermissionRule } = await import(process.argv[2]);
const [projectDir, tag, home] = [process.argv[3], process.argv[4], process.argv[5]];
for (let i = 0; i < 15; i += 1) await appendPermissionRule({ home, projectDir, rule: 'Bash(' + tag + i + ')', effect: 'allow' });
`,
    );
    const runChild = (tag: string): Promise<number | null> =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [script, CONFIG_ENTRY, tree.project, tag, tree.home], { stdio: 'ignore' });
        registerCleanup(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
        });
        child.on('exit', (code) => resolve(code));
      });
    expect(await Promise.all([runChild('a'), runChild('b')])).toEqual([0, 0]);
    const allow = (readLocal(tree).permissions as { allow: string[] }).allow;
    const expected = ['a', 'b'].flatMap((tag) => Array.from({ length: 15 }, (_, i) => `Bash(${tag}${i})`));
    expect([...allow].sort()).toEqual(expected.sort());
  });
});
