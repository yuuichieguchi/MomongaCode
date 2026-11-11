import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, PROJECT_MANDATE_FILE, editProjectMandate, loadProjectMandate, settingsFileLock, systemFileLockPorts } from '@momonga/config';
import { distrusting, makeDir, makeTree, trusting, writeJson } from './helpers.ts';
import type { Tree } from './helpers.ts';
import { testKernelLock } from '@momonga/testkit';

const signal = new AbortController().signal;

type Edit = (document: Record<string, unknown>) => boolean;
type Trust = { isTrusted(directory: string, signal: AbortSignal): boolean | Promise<boolean> };

const optionsOf = (tree: Tree, trust: Trust) => ({ trust, mechanism: testKernelLock(), lock: settingsFileLock(tree.home, { lock: testKernelLock() }), random: systemFileLockPorts.random, signal });

const mandateFile = (tree: Tree): string => path.join(tree.project, PROJECT_MANDATE_FILE);

const setting = (values: Record<string, unknown>): Edit => (document) => {
  Object.assign(document, values);
  return true;
};

const trustedEdit = (tree: Tree, edit: Edit): Promise<void> => editProjectMandate(tree.project, edit, optionsOf(tree, trusting(tree)));

const DECLARED = { ask: ['GitPush(origin:release/*)'], deny: ['Bash(curl:*)'], until: ['npm test'], steps: 20 };

describe('editProjectMandate: the one writer of .momonga/mandate.json', () => {
  it('writes a valid mandate into the file of a trusted folder, with mode 0600, and the loader reads it back', async () => {
    const tree = makeTree();
    await trustedEdit(tree, setting(DECLARED));
    expect(JSON.parse(fs.readFileSync(mandateFile(tree), 'utf8'))).toEqual(DECLARED);
    expect(fs.statSync(mandateFile(tree)).mode & 0o777).toBe(0o600);
    expect(await loadProjectMandate({ projectDir: tree.project, trusted: true, signal })).toEqual(DECLARED);
  });

  it('changes one key of the file that is there and keeps the others', async () => {
    const tree = makeTree();
    writeJson(mandateFile(tree), DECLARED);
    await trustedEdit(tree, setting({ steps: 5 }));
    expect(JSON.parse(fs.readFileSync(mandateFile(tree), 'utf8'))).toEqual({ ...DECLARED, steps: 5 });
  });

  it('refuses a folder that is not trusted, asks the trust port about that folder, and writes nothing', async () => {
    const tree = makeTree();
    const asked: string[] = [];
    const trust: Trust = {
      isTrusted: (directory) => {
        asked.push(directory);
        return false;
      },
    };
    const refused = editProjectMandate(tree.project, setting(DECLARED), optionsOf(tree, trust));
    await expect(refused).rejects.toBeInstanceOf(ConfigError);
    await expect(refused).rejects.toThrow(`${mandateFile(tree)}: the folder ${tree.project} is not trusted, so its mandate file is not written`);
    expect(asked).toEqual([tree.project]);
    expect(fs.existsSync(path.join(tree.project, '.momonga'))).toBe(false);
    await expect(editProjectMandate(tree.project, setting(DECLARED), optionsOf(tree, distrusting()))).rejects.toBeInstanceOf(ConfigError);
  });

  it.each([
    [{ allow: ['Bash(npm test)'] }, 'allow can only be declared in the user settings (mandates)'],
    [{ onQuiescent: 'stop' }, 'onQuiescent can only be declared in the user settings (mandates)'],
    [{ steps: 0 }, '/steps must be >= 1'],
    [{ deny: ['Bash('] }, 'the deny rule "Bash(" is not a permission rule'],
  ])('does not write %j and gives the sentence of the loader, which names the key', async (values, sentence) => {
    const tree = makeTree();
    writeJson(mandateFile(tree), DECLARED);
    const before = fs.readFileSync(mandateFile(tree), 'utf8');
    const refused = trustedEdit(tree, setting(values));
    await expect(refused).rejects.toBeInstanceOf(ConfigError);
    await expect(refused).rejects.toThrow(`${mandateFile(tree)}: ${sentence}`);
    expect(fs.readFileSync(mandateFile(tree), 'utf8')).toBe(before);
  });

  it('repairs a mandate file that does not load', async () => {
    const tree = makeTree();
    writeJson(mandateFile(tree), { ...DECLARED, allow: ['Bash(npm test)'] });
    await expect(loadProjectMandate({ projectDir: tree.project, trusted: true, signal })).rejects.toBeInstanceOf(ConfigError);
    await trustedEdit(tree, (document) => {
      delete document['allow'];
      return true;
    });
    expect(await loadProjectMandate({ projectDir: tree.project, trusted: true, signal })).toEqual(DECLARED);
  });

  it('leaves the bytes of the file when the edit changes nothing', async () => {
    const tree = makeTree();
    fs.mkdirSync(path.dirname(mandateFile(tree)), { recursive: true });
    fs.writeFileSync(mandateFile(tree), '{"steps":20}');
    await trustedEdit(tree, () => false);
    expect(fs.readFileSync(mandateFile(tree), 'utf8')).toBe('{"steps":20}');
  });
});

describe.skipIf(process.platform === 'win32')('editProjectMandate on a mandate file that is a symbolic link (skipped on Windows, where creating a link needs a right the test host may lack)', () => {
  const linkTo = (tree: Tree, target: string): string => {
    const link = mandateFile(tree);
    fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
    fs.symlinkSync(target, link);
    return link;
  };

  it('writes the file the link names inside the project and leaves the link a link', async () => {
    const tree = makeTree();
    const target = writeJson(path.join(tree.project, 'shared', 'mandate.json'), { steps: 20 });
    const link = linkTo(tree, target);
    await trustedEdit(tree, setting({ steps: 5 }));
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe(target);
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ steps: 5 });
  });

  it('refuses a link that leaves the project with the sentence of the reader and writes nothing', async () => {
    const tree = makeTree();
    const target = writeJson(path.join(makeDir(), 'mandate.json'), { steps: 20 });
    const before = fs.readFileSync(target, 'utf8');
    linkTo(tree, target);
    await expect(trustedEdit(tree, setting({ steps: 5 }))).rejects.toThrow(`${mandateFile(tree)}: symlink target ${target} is outside the project ${tree.project}`);
    expect(fs.readFileSync(target, 'utf8')).toBe(before);
  });

  it('refuses a link that names nothing with the sentence of the reader', async () => {
    const tree = makeTree();
    const missing = path.join(tree.project, 'gone.json');
    const link = linkTo(tree, missing);
    await expect(trustedEdit(tree, setting({ steps: 5 }))).rejects.toThrow(`${link}: dangling symlink`);
    expect(fs.existsSync(missing)).toBe(false);
  });
});
