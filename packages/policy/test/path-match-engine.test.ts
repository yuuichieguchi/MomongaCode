import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_PROTECTED_SET, ruleEnforcementOf } from '@momonga/foundation';
import { computeFileRules, decide, parseRule } from '@momonga/policy';
import type { PermissionRule, PermissionSubject, PolicyTool, RuleEffect } from '@momonga/policy';
import { TEST_SEARCH_PATH, fakeFs, isWritableFor, makeLayout, touch } from './helpers.ts';
import type { Layout } from './helpers.ts';
import { testProbes } from '@momonga/testkit';

const TOOLS: Record<string, PolicyTool> = {
  Read: { name: 'Read', kind: 'read', sideEffect: 'read_only' },
  Grep: { name: 'Grep', kind: 'search', sideEffect: 'read_only' },
  Glob: { name: 'Glob', kind: 'search', sideEffect: 'read_only' },
  Write: { name: 'Write', kind: 'edit', sideEffect: 'write', subjectKind: 'path' },
};

type Fixture = Layout & { extra: string };

const fixture = (): Fixture => {
  const layout = makeLayout();
  const extra = path.join(layout.root, 'extra');
  fs.mkdirSync(extra, { mode: 0o700 });
  return { ...layout, extra };
};

type RuleSpec = { effect: RuleEffect; text: string; exceptions?: readonly string[] };

const rulesOf = (fx: Fixture, specs: readonly RuleSpec[]): PermissionRule[] =>
  specs.map(({ effect, text, exceptions }) => {
    const rule = parseRule(text, { effect, origin: 'user', source: 'user-settings', settingsRoot: fx.project, home: fx.home, cwd: fx.project });
    return exceptions === undefined ? rule : ({ ...rule, exceptions } as PermissionRule);
  });

const decideOn = async (fx: Fixture, specs: readonly RuleSpec[], tool: keyof typeof TOOLS, target: string, mode: 'manual' | 'acceptEdits' = 'manual') => {
  const rules = rulesOf(fx, specs);
  const roots = [fx.project, fx.extra];
  const access = tool === 'Write' ? 'write' : 'read';
  const subject: PermissionSubject = { kind: 'path', tool, paths: [target], access };
  const decision = await decide({
    tool: TOOLS[tool] as PolicyTool,
    subject,
    mode,
    rules,
    roots,
    home: fx.home,
    cwd: fx.project,
    fileRules: await computeFileRules(rules, roots, null, ruleEnforcementOf('none'), testProbes()),
    fs: fakeFs(), searchPath: TEST_SEARCH_PATH, isWritable: isWritableFor(roots),
    protectedSet: EMPTY_PROTECTED_SET,
  });
  return { kind: decision.kind, source: decision.source };
};

const DENY_ENV: RuleSpec[] = [{ effect: 'deny', text: 'Read(.env)' }];

describe('decision table of R1a 3.11, pins that hold on main and after', () => {
  it('Read(.env) deny matches a nested .env under the cwd', async () => {
    const fx = fixture();
    expect(await decideOn(fx, DENY_ENV, 'Read', touch(path.join(fx.project, 'sub', '.env')))).toEqual({ kind: 'deny', source: 'rule' });
  });

  it('Read(.env) deny matches the .env of an additional directory', async () => {
    const fx = fixture();
    expect(await decideOn(fx, DENY_ENV, 'Read', touch(path.join(fx.extra, '.env')))).toEqual({ kind: 'deny', source: 'rule' });
  });

  it('Read(.env) ask matches the .env of an additional directory', async () => {
    const fx = fixture();
    expect(await decideOn(fx, [{ effect: 'ask', text: 'Read(.env)' }], 'Read', touch(path.join(fx.extra, '.env')))).toEqual({ kind: 'ask', source: 'rule' });
  });

  it('Write(*.pem) deny matches a write into an additional directory', async () => {
    const fx = fixture();
    expect(await decideOn(fx, [{ effect: 'deny', text: 'Write(*.pem)' }], 'Write', path.join(fx.extra, 'x.pem'), 'acceptEdits')).toEqual({ kind: 'deny', source: 'rule' });
  });

  it('Edit(src/**) allow does not match vendor/src under the cwd', async () => {
    const fx = fixture();
    expect(await decideOn(fx, [{ effect: 'allow', text: 'Edit(src/**)' }], 'Write', path.join(fx.project, 'vendor', 'src', 'a.ts'))).toEqual({ kind: 'ask', source: 'mode' });
  });

  it('a project symlink to a file outside it is not approved by an allow rule', async () => {
    const fx = fixture();
    const outside = touch(path.join(fx.outside, 'a.ts'));
    fs.symlinkSync(outside, path.join(fx.project, 'link.ts'));
    expect(await decideOn(fx, [{ effect: 'allow', text: 'Write(*.ts)' }], 'Write', path.join(fx.project, 'link.ts'))).toEqual({ kind: 'ask', source: 'mode' });
  });
});

describe('decision table of R1a 3.11, rows that change', () => {
  it('Read(.env) deny does not match a .env outside every root', async () => {
    const fx = fixture();
    expect(await decideOn(fx, DENY_ENV, 'Read', touch(path.join(fx.outside, 'proj2', '.env')))).toEqual({ kind: 'ask', source: 'mode' });
  });

  it('Read(.env) deny does not match the .env of a parent directory', async () => {
    const fx = fixture();
    expect(await decideOn(fx, DENY_ENV, 'Read', touch(path.join(fx.root, '.env')))).toEqual({ kind: 'ask', source: 'mode' });
  });

  it('Read(node_modules) deny does not match a node_modules outside every root', async () => {
    const fx = fixture();
    expect(await decideOn(fx, [{ effect: 'deny', text: 'Read(node_modules)' }], 'Read', touch(path.join(fx.outside, 'node_modules', 'm', 'index.js')))).toEqual({
      kind: 'ask',
      source: 'mode',
    });
  });

  it('Read(secrets/**) deny matches a secrets directory at any depth under the cwd', async () => {
    const fx = fixture();
    expect(await decideOn(fx, [{ effect: 'deny', text: 'Read(secrets/**)' }], 'Read', touch(path.join(fx.project, 'vendor', 'secrets', 'k')))).toEqual({
      kind: 'deny',
      source: 'rule',
    });
  });

  it('Read(secrets/**) deny matches secrets inside an additional directory', async () => {
    const fx = fixture();
    expect(await decideOn(fx, [{ effect: 'deny', text: 'Read(secrets/**)' }], 'Read', touch(path.join(fx.extra, 'secrets', 'k')))).toEqual({ kind: 'deny', source: 'rule' });
  });

  it('Read(src/a.ts) deny matches src/a.ts inside an additional directory', async () => {
    const fx = fixture();
    expect(await decideOn(fx, [{ effect: 'deny', text: 'Read(src/a.ts)' }], 'Read', touch(path.join(fx.extra, 'src', 'a.ts')))).toEqual({ kind: 'deny', source: 'rule' });
  });

  it('Read(secrets/*) deny matches a file below a matched directory', async () => {
    const fx = fixture();
    expect(await decideOn(fx, [{ effect: 'deny', text: 'Read(secrets/*)' }], 'Read', touch(path.join(fx.project, 'secrets', 'a', 'key')))).toEqual({ kind: 'deny', source: 'rule' });
  });

  it.each(['Grep', 'Glob'] as const)('Read(.env) deny denies a %s subject on .env', async (tool) => {
    const fx = fixture();
    expect(await decideOn(fx, DENY_ENV, tool, touch(path.join(fx.project, '.env')))).toEqual({ kind: 'deny', source: 'rule' });
  });

  it('allow Write(.env) matches .env/inner.txt by closure', async () => {
    const fx = fixture();
    expect(await decideOn(fx, [{ effect: 'allow', text: 'Write(.env)' }], 'Write', touch(path.join(fx.project, '.env', 'inner.txt')))).toEqual({ kind: 'allow', source: 'rule' });
  });

  it('allow Write(*.ts) does not match a path in an additional directory', async () => {
    const fx = fixture();
    expect(await decideOn(fx, [{ effect: 'allow', text: 'Write(*.ts)' }], 'Write', touch(path.join(fx.extra, 'a.ts')))).toEqual({ kind: 'ask', source: 'mode' });
  });

  it('allow Write(*.ts) requires the requested form to match as well as the resolved one', async () => {
    const fx = fixture();
    const real = touch(path.join(fx.project, 'real.ts'));
    fs.symlinkSync(real, path.join(fx.project, 'link.txt'));
    expect(await decideOn(fx, [{ effect: 'allow', text: 'Write(*.ts)' }], 'Write', path.join(fx.project, 'link.txt'))).toEqual({ kind: 'ask', source: 'mode' });
    expect(await decideOn(fx, [{ effect: 'allow', text: 'Write(*.ts)' }], 'Write', real)).toEqual({ kind: 'allow', source: 'rule' });
  });

  it('allow Edit(src/**) matches the node src itself', async () => {
    const fx = fixture();
    fs.mkdirSync(path.join(fx.project, 'src'));
    expect(await decideOn(fx, [{ effect: 'allow', text: 'Edit(src/**)' }], 'Write', path.join(fx.project, 'src'))).toEqual({ kind: 'allow', source: 'rule' });
  });

  it('Read(*.env) with the exception sample.env leaves sample.env to the mode and denies other .env files', async () => {
    const fx = fixture();
    const specs: RuleSpec[] = [{ effect: 'deny', text: 'Read(*.env)', exceptions: ['sample.env'] }];
    expect(await decideOn(fx, specs, 'Read', touch(path.join(fx.project, 'sample.env')))).toEqual({ kind: 'allow', source: 'mode' });
    expect(await decideOn(fx, specs, 'Read', touch(path.join(fx.project, 'x.env')))).toEqual({ kind: 'deny', source: 'rule' });
  });

  it('braces are literal: Read(**/*.{pem,key}) does not match k.pem', async () => {
    const fx = fixture();
    expect(await decideOn(fx, [{ effect: 'deny', text: 'Read(**/*.{pem,key})' }], 'Read', touch(path.join(fx.project, 'k.pem')))).toEqual({ kind: 'allow', source: 'mode' });
  });
});
