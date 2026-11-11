import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, PROJECT_MANDATE_FILE, approvalDigestOf, loadProjectMandate, parseProjectMandate } from '@momonga/config';

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
    const projectDir = projectWith(declared);
    expect(await loadProjectMandate({ signal: new AbortController().signal, projectDir, trusted: true, approvals: { [projectDir]: { mandate: approvalDigestOf(declared) } } })).toEqual(declared);
  });

  it('is refused in a trusted folder until the person approved this content, naming the file', async () => {
    const declared = { deny: ['Bash(curl:*)'], until: ['npm test'] };
    const projectDir = projectWith(declared);
    const file = path.join(projectDir, PROJECT_MANDATE_FILE);
    const message = `${file}: the mandate file is not approved for this folder, or changed since it was approved; new runs are refused until it is approved`;
    await expect(loadProjectMandate({ signal: new AbortController().signal, projectDir, trusted: true, approvals: undefined })).rejects.toThrow(message);
    const before = { ...declared, until: ['true'] };
    await expect(loadProjectMandate({ signal: new AbortController().signal, projectDir, trusted: true, approvals: { [projectDir]: { mandate: approvalDigestOf(before) } } })).rejects.toThrow(ConfigError);
    await expect(loadProjectMandate({ signal: new AbortController().signal, projectDir, trusted: true, approvals: { [projectDir]: { mandate: approvalDigestOf(before) } } })).rejects.toThrow(message);
  });

  it('is not read in a folder that is not trusted, whatever it holds', async () => {
    expect(await loadProjectMandate({ signal: new AbortController().signal, projectDir: projectWith('{ not json'), trusted: false, approvals: undefined })).toBeUndefined();
    expect(await loadProjectMandate({ signal: new AbortController().signal, projectDir: projectWith({ allow: ['Bash'] }), trusted: false, approvals: undefined })).toBeUndefined();
  });

  it('is absent when the folder has no such file', async () => {
    expect(await loadProjectMandate({ signal: new AbortController().signal, projectDir: projectWith(undefined), trusted: true, approvals: undefined })).toBeUndefined();
  });

  it.each(['allow', 'onQuiescent'])('refuses %s, which only the user settings may declare', async (key) => {
    const projectDir = projectWith({ [key]: key === 'allow' ? ['Bash(git:*)'] : 'wait' });
    await expect(loadProjectMandate({ signal: new AbortController().signal, projectDir, trusted: true, approvals: undefined })).rejects.toThrow(ConfigError);
    await expect(loadProjectMandate({ signal: new AbortController().signal, projectDir, trusted: true, approvals: undefined })).rejects.toThrow(`${key} can only be declared in the user settings`);
  });

  it('refuses an allow rule even in content the person approved: a project file only narrows a mandate (ruling 2026-11-11, P-592)', async () => {
    const declared = { allow: ['Bash(git:*)'], ask: ['Bash'] };
    const projectDir = projectWith(declared);
    const loading = loadProjectMandate({ signal: new AbortController().signal, projectDir, trusted: true, approvals: { [projectDir]: { mandate: approvalDigestOf(declared) } } });
    await expect(loading).rejects.toThrow(`${path.join(projectDir, PROJECT_MANDATE_FILE)}: allow can only be declared in the user settings (mandates)`);
  });

  it('loads approved ask and deny rules with budgets smaller than any mandate', async () => {
    const declared = { ask: ['Bash(npm:*)'], deny: ['Write'], steps: 5, tokens: 10_000, costUsd: 0.25, timeMs: 60_000 };
    const projectDir = projectWith(declared);
    expect(await loadProjectMandate({ signal: new AbortController().signal, projectDir, trusted: true, approvals: { [projectDir]: { mandate: approvalDigestOf(declared) } } })).toEqual(declared);
  });

  it('refuses a key it does not know, a rule that is not a permission rule and a budget out of range, naming the file', () => {
    expect(() => parseProjectMandate({ scope: {} }, '/p/.momonga/mandate.json')).toThrow('/p/.momonga/mandate.json');
    expect(() => parseProjectMandate({ deny: ['Bash(('] }, '/p/.momonga/mandate.json')).toThrow('is not a permission rule');
    expect(() => parseProjectMandate({ steps: 0 }, '/p/.momonga/mandate.json')).toThrow(ConfigError);
  });
});
