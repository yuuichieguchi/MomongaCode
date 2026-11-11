import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ruleEnforcementOf } from '@momonga/foundation';
import { computeFileRules, parseRule } from '@momonga/policy';
import type { PermissionRule } from '@momonga/policy';
import { createReadAccessMatcher } from '../src/read-access.ts';
import { testProbes, testPaths } from '@momonga/testkit';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const makeProject = (): string => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-rforms-')));
  tempDirs.push(dir);
  return dir;
};

const errnoError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: injected`), { code });

const thrownBy = async (action: () => unknown): Promise<unknown> => {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
};

const denyRule = (cwd: string, text: string): PermissionRule =>
  parseRule(text, { effect: 'deny', origin: 'user', source: 'user-settings', settingsRoot: cwd, home: cwd, cwd });

const matcherFor = async (cwd: string, texts: readonly string[]) => {
  const rules = texts.map((text) => denyRule(cwd, text));
  return createReadAccessMatcher({ readDenied: [], readAllowed: [], fileRules: await computeFileRules(rules, [cwd], null, ruleEnforcementOf('none'), testProbes()) }, testPaths());
};

const loopProject = (): string => {
  const cwd = makeProject();
  const loop = path.join(cwd, 'loop');
  fs.symlinkSync(loop, loop);
  return cwd;
};

describe('read access candidate forms and an unresolvable path', () => {
  it('blockedBy checks the requested form of an ELOOP path as a deny', async () => {
    const cwd = loopProject();
    const matcher = await matcherFor(cwd, ['Read(loop/**)']);
    expect((await matcher.blockedBy('loop/x', cwd))?.ruleText).toBe('Read(loop/**)');
    expect((await matcher.blockedBy(path.join(cwd, 'loop', 'x'), cwd))?.ruleText).toBe('Read(loop/**)');
  });

  it('blockedBy does not block an ELOOP path whose requested form no deny covers', async () => {
    const cwd = loopProject();
    expect(await (await matcherFor(cwd, ['Read(other/**)'])).blockedBy('loop/x', cwd)).toBeUndefined();
  });

  it('writeBlockedBy checks the requested form of an ELOOP path as a deny', async () => {
    const cwd = loopProject();
    const matcher = await matcherFor(cwd, ['Edit(loop/**)', 'Edit(other/**)']);
    expect((await matcher.writeBlockedBy('loop/x', cwd))?.ruleText).toBe('Edit(loop/**)');
    expect(await (await matcherFor(cwd, ['Edit(other/**)'])).writeBlockedBy('loop/x', cwd)).toBeUndefined();
  });
});

describe('read access candidate forms and a canonicaliser error outside the unresolvable set', () => {
  const injectAt = (target: string, error: NodeJS.ErrnoException): void => {
    const realLstat = fs.promises.lstat;
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (candidate: fs.PathLike, options?: unknown) => {
      if (String(candidate) === target) throw error;
      return realLstat(candidate, options as never);
    }) as typeof fs.promises.lstat);
  };

  it.each(['EMFILE', 'EIO'])('blockedBy rethrows an injected %s unchanged', async (code) => {
    const cwd = makeProject();
    const matcher = await matcherFor(cwd, ['Read(secret/**)']);
    const target = path.join(cwd, 'plain');
    fs.writeFileSync(target, 'x');
    const injected = errnoError(code);
    injectAt(target, injected);
    expect(await thrownBy(async () => matcher.blockedBy('plain', cwd))).toBe(injected);
  });

  it.each(['EMFILE', 'EIO'])('writeBlockedBy rethrows an injected %s unchanged', async (code) => {
    const cwd = makeProject();
    const matcher = await matcherFor(cwd, ['Edit(secret/**)']);
    const target = path.join(cwd, 'plain');
    fs.writeFileSync(target, 'x');
    const injected = errnoError(code);
    injectAt(target, injected);
    expect(await thrownBy(async () => matcher.writeBlockedBy('plain', cwd))).toBe(injected);
  });
});
