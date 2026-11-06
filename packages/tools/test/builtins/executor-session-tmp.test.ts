import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { momongaLayout, EMPTY_PROTECTED_SET, ruleEnforcementOf } from '@momonga/foundation';
import { computeFileRules } from '@momonga/policy';
import { buildSandboxPolicy } from '@momonga/tools';
import { makeBuiltins, resultOf } from './fixtures.ts';
import type { RunExtra } from './fixtures.ts';

const ACCEPT = { mode: 'acceptEdits' } as const;

const fixture = async () => {
  const tools = await makeBuiltins();
  const { home, project } = tools.layout;
  const sessions = momongaLayout(home, process.platform, {}).tmp.sessions;
  const tmpDir = path.join(sessions, 'session-1');
  const sibling = path.join(sessions, 'session-2');
  for (const dir of [tmpDir, sibling]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(sibling, 'secret.txt'), 'sibling secret\n');
  const extra: RunExtra = {
    ...ACCEPT,
    roots: [project],
    tmpDir,
    sandboxPolicy: buildSandboxPolicy({ protectedSet: EMPTY_PROTECTED_SET, fileRules: computeFileRules([], [project], tmpDir, ruleEnforcementOf('none')), roots: [project], home, tmpDir, sessionsTmpRoot: sessions }),
  };
  return { tools, sessions, tmpDir, sibling, extra };
};

describe('executor: batch.tmpDir is a builtin root', () => {
  it('Write creates a file in tmpDir although batch.roots omits it and the sessions root is write-denied', async () => {
    const fx = await fixture();
    const target = path.join(fx.tmpDir, 'f');
    const result = resultOf(await fx.tools.run('Write', { file_path: target, content: 'hello' }, fx.extra));
    expect(result.status).toBe('completed');
    expect(fs.readFileSync(target, 'utf8')).toBe('hello');
  });

  it("Write into a sibling session's dir is denied", async () => {
    const fx = await fixture();
    const target = path.join(fx.sibling, 'f');
    const result = resultOf(await fx.tools.run('Write', { file_path: target, content: 'x' }, { ...fx.extra, mode: 'bypassPermissions' }, 'allow_once'));
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(/^Permission denied: /);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('Write directly into the sessions root is denied', async () => {
    const fx = await fixture();
    const target = path.join(fx.sessions, 'x');
    const result = resultOf(await fx.tools.run('Write', { file_path: target, content: 'x' }, { ...fx.extra, mode: 'bypassPermissions' }, 'allow_once'));
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(/^Permission denied: /);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('Read reads a file inside tmpDir', async () => {
    const fx = await fixture();
    const target = path.join(fx.tmpDir, 'note.txt');
    fs.writeFileSync(target, 'session note\n');
    const result = resultOf(await fx.tools.run('Read', { file_path: target }, fx.extra));
    expect(result.status).toBe('completed');
    expect(result.output).toContain('session note');
  });

  it('Glob lists files inside tmpDir', async () => {
    const fx = await fixture();
    const target = path.join(fx.tmpDir, 'note.txt');
    fs.writeFileSync(target, 'session note\n');
    const result = resultOf(await fx.tools.run('Glob', { pattern: '*.txt', path: fx.tmpDir }, fx.extra));
    expect(result.status).toBe('completed');
    expect(result.output.split('\n').filter((line) => line !== '')).toEqual([target]);
  });

  it("Read of a sibling session's file is denied", async () => {
    const fx = await fixture();
    const result = resultOf(await fx.tools.run('Read', { file_path: path.join(fx.sibling, 'secret.txt') }, { ...fx.extra, mode: 'bypassPermissions' }, 'allow_once'));
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(/^Permission denied: .* is blocked by the sandbox policy$/);
    expect(result.output).not.toContain('sibling secret');
  });
});
