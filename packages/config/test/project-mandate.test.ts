import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, PROJECT_MANDATE_FILE, loadProjectMandate, parseProjectMandate } from '@momonga/config';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const projectWith = (content: unknown): string => {
  const projectDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-project-mandate-')));
  roots.push(projectDir);
  if (content !== undefined) {
    fs.mkdirSync(path.join(projectDir, '.momonga'));
    fs.writeFileSync(path.join(projectDir, PROJECT_MANDATE_FILE), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return projectDir;
};

describe('the project file .momonga/mandate.json', () => {
  it('is read in a trusted folder: ask and deny rules, completion conditions and budget dimensions', async () => {
    const declared = { ask: ['GitPush(origin:release/*)'], deny: ['Bash(curl:*)'], until: ['npm test'], require: ['the changelog is updated'], steps: 20, tokens: 100_000, costUsd: 1.5, timeMs: 600_000, retries: 2 };
    expect(await loadProjectMandate({ signal: new AbortController().signal, projectDir: projectWith(declared), trusted: true })).toEqual(declared);
  });

  it('is not read in a folder that is not trusted, whatever it holds', async () => {
    expect(await loadProjectMandate({ signal: new AbortController().signal, projectDir: projectWith('{ not json'), trusted: false })).toBeUndefined();
    expect(await loadProjectMandate({ signal: new AbortController().signal, projectDir: projectWith({ allow: ['Bash'] }), trusted: false })).toBeUndefined();
  });

  it('is absent when the folder has no such file', async () => {
    expect(await loadProjectMandate({ signal: new AbortController().signal, projectDir: projectWith(undefined), trusted: true })).toBeUndefined();
  });

  it.each(['allow', 'onQuiescent'])('refuses %s, which only the user settings may declare', async (key) => {
    const projectDir = projectWith({ [key]: key === 'allow' ? ['Bash(git:*)'] : 'wait' });
    await expect(loadProjectMandate({ signal: new AbortController().signal, projectDir, trusted: true })).rejects.toThrow(ConfigError);
    await expect(loadProjectMandate({ signal: new AbortController().signal, projectDir, trusted: true })).rejects.toThrow(`${key} can only be declared in the user settings`);
  });

  it('refuses a key it does not know, a rule that is not a permission rule and a budget out of range, naming the file', () => {
    expect(() => parseProjectMandate({ scope: {} }, '/p/.momonga/mandate.json')).toThrow('/p/.momonga/mandate.json');
    expect(() => parseProjectMandate({ deny: ['Bash(('] }, '/p/.momonga/mandate.json')).toThrow('is not a permission rule');
    expect(() => parseProjectMandate({ steps: 0 }, '/p/.momonga/mandate.json')).toThrow(ConfigError);
  });
});
