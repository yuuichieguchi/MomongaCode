import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { matchRule } from '@momonga/policy';
import type { PermissionRule, RuleEffect } from '@momonga/policy';
import { fileRulesFor, makeLayout, ruleIn } from './helpers.ts';
import type { Layout } from './helpers.ts';
import { testProbes } from '@momonga/testkit';

afterEach(() => {
  vi.restoreAllMocks();
});

const errnoError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: injected`), { code });

const thrownBy = async (action: () => unknown): Promise<unknown> => {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
};

const editOf = (target: string) => ({ kind: 'path', tool: 'Edit', paths: [target], access: 'write' }) as const;

const matches = async (rule: PermissionRule, target: string): Promise<boolean> => matchRule(rule, editOf(target), await fileRulesFor([rule], [rule.cwd]), 0, testProbes().canonicalise);

const loopLayout = (): { layout: Layout; target: string } => {
  const layout = makeLayout();
  const src = path.join(layout.project, 'src');
  fs.mkdirSync(src, { mode: 0o700 });
  const loop = path.join(src, 'loop');
  fs.symlinkSync(loop, loop);
  return { layout, target: path.join(src, 'loop', 'x') };
};

describe('matchRule and an unresolvable candidate', () => {
  it('an allow Edit(src/**) does not match src/loop/x when loop is a self-referential symlink', async () => {
    const { layout, target } = loopLayout();
    expect(await matches(ruleIn(layout)('allow', 'Edit(src/**)'), target)).toBe(false);
    expect(await matches(ruleIn(layout)('allow', 'Edit(src/**)'), 'src/loop/x')).toBe(false);
  });

  it.each(['deny', 'ask'] as const)('a %s Edit(src/**) matches src/loop/x by its lexical form', async (effect: RuleEffect) => {
    const { layout, target } = loopLayout();
    expect(await matches(ruleIn(layout)(effect, 'Edit(src/**)'), target)).toBe(true);
    expect(await matches(ruleIn(layout)(effect, 'Edit(src/**)'), 'src/loop/x')).toBe(true);
  });

  it('a deny Edit(other/**) does not match src/loop/x', async () => {
    const { layout, target } = loopLayout();
    expect(await matches(ruleIn(layout)('deny', 'Edit(other/**)'), target)).toBe(false);
  });
});

describe('matchRule and a canonicaliser error outside the unresolvable set', () => {
  it.each(['allow', 'deny', 'ask'] as const)('rethrows an injected EMFILE unchanged for a %s rule', async (effect: RuleEffect) => {
    const layout = makeLayout();
    const src = path.join(layout.project, 'src');
    fs.mkdirSync(src, { mode: 0o700 });
    const target = path.join(src, 'x');
    fs.writeFileSync(target, 'x', { mode: 0o600 });
    const rule = ruleIn(layout)(effect, 'Edit(src/**)');
    const fileRules = await fileRulesFor([rule], [rule.cwd]);
    const injected = errnoError('EMFILE');
    const realLstat = fs.promises.lstat;
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (candidate: fs.PathLike, options?: unknown) => {
      if (String(candidate) === target) throw injected;
      return realLstat(candidate, options as never);
    }) as typeof fs.promises.lstat);
    expect(await thrownBy(async () => matchRule(rule, editOf(target), await fileRules, 0, testProbes().canonicalise))).toBe(injected);
  });
});
