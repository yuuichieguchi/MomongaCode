import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOST_RULE_ENFORCEMENT } from '@momonga/foundation';
import { computeFileRules, fileRuleSpecsOf, parseRule } from '@momonga/policy';
import type { PermissionRule, RuleEffect, RuleOrigin } from '@momonga/policy';
import { makeLayout } from './helpers.ts';
import type { Layout } from './helpers.ts';

const extraOf = (layout: Layout): string => {
  const extra = path.join(layout.root, 'extra');
  fs.mkdirSync(extra, { mode: 0o700 });
  return extra;
};

const ruleOf = (layout: Layout, origin: RuleOrigin, effect: RuleEffect, text: string, exceptions?: readonly string[]): PermissionRule => {
  const rule = parseRule(text, { effect, origin, source: `${origin}-settings`, settingsRoot: layout.project, home: layout.home, cwd: layout.project });
  return exceptions === undefined ? rule : ({ ...rule, exceptions } as PermissionRule);
};

const summary = (rules: readonly PermissionRule[], roots: readonly string[]) =>
  computeFileRules(rules, roots, null, HOST_RULE_ENFORCEMENT).entries.map((entry) => ({
    ruleIndex: entry.ruleIndex,
    tool: entry.tool,
    access: entry.access,
    effect: entry.effect,
    anchorDirectory: entry.anchorDirectory,
  }));

describe('computeFileRules mapping', () => {
  it('maps Read deny to a read entry and Write and Edit deny to write entries of the Edit family', () => {
    const layout = makeLayout();
    const rules = [ruleOf(layout, 'user', 'deny', 'Read(.env)'), ruleOf(layout, 'user', 'deny', 'Write(*.pem)'), ruleOf(layout, 'user', 'deny', 'Edit(*.key)')];
    expect(summary(rules, [layout.project])).toEqual([
      { ruleIndex: 0, tool: 'Read', access: 'read', effect: 'deny', anchorDirectory: layout.project },
      { ruleIndex: 1, tool: 'Edit', access: 'write', effect: 'deny', anchorDirectory: layout.project },
      { ruleIndex: 2, tool: 'Edit', access: 'write', effect: 'deny', anchorDirectory: layout.project },
    ]);
  });

  it('makes an entry for every path rule of every effect and tool, and none for bare tools or Bash', () => {
    const layout = makeLayout();
    const rules = [
      ruleOf(layout, 'user', 'ask', 'Read(*.log)'),
      ruleOf(layout, 'user', 'allow', 'Edit(src/**)'),
      ruleOf(layout, 'user', 'deny', 'Glob(gen/**)'),
      ruleOf(layout, 'user', 'deny', 'Grep(data/**)'),
      ruleOf(layout, 'user', 'deny', 'Read'),
      ruleOf(layout, 'user', 'deny', 'Bash(rm:*)'),
      ruleOf(layout, 'user', 'allow', 'Read(docs/**)'),
    ];
    expect(summary(rules, [layout.project])).toEqual([
      { ruleIndex: 0, tool: 'Read', access: 'read', effect: 'ask', anchorDirectory: layout.project },
      { ruleIndex: 1, tool: 'Edit', access: 'write', effect: 'allow', anchorDirectory: path.join(layout.project, 'src') },
      { ruleIndex: 2, tool: 'Glob', access: 'read', effect: 'deny', anchorDirectory: layout.project },
      { ruleIndex: 3, tool: 'Grep', access: 'read', effect: 'deny', anchorDirectory: layout.project },
      { ruleIndex: 6, tool: 'Read', access: 'read', effect: 'allow', anchorDirectory: path.join(layout.project, 'docs') },
    ]);
  });

  it('expands deny and ask relative rules once per root and anchors allow rules at the cwd', () => {
    const layout = makeLayout();
    const extra = extraOf(layout);
    const rules = [ruleOf(layout, 'user', 'deny', 'Read(.env)'), ruleOf(layout, 'user', 'ask', 'Read(*.log)'), ruleOf(layout, 'user', 'allow', 'Read(.env)')];
    expect(summary(rules, [layout.project, extra])).toEqual([
      { ruleIndex: 0, tool: 'Read', access: 'read', effect: 'deny', anchorDirectory: layout.project },
      { ruleIndex: 0, tool: 'Read', access: 'read', effect: 'deny', anchorDirectory: extra },
      { ruleIndex: 1, tool: 'Read', access: 'read', effect: 'ask', anchorDirectory: layout.project },
      { ruleIndex: 1, tool: 'Read', access: 'read', effect: 'ask', anchorDirectory: extra },
      { ruleIndex: 2, tool: 'Read', access: 'read', effect: 'allow', anchorDirectory: layout.project },
    ]);
  });

  it('anchors //, ~/ and / forms once', () => {
    const layout = makeLayout();
    const extra = extraOf(layout);
    const rules = [
      ruleOf(layout, 'user', 'deny', `Read(/${layout.outside}/**)`),
      ruleOf(layout, 'user', 'deny', 'Read(~/.ssh/**)'),
      ruleOf(layout, 'project', 'deny', 'Read(/docs/**)'),
    ];
    expect(summary(rules, [layout.project, extra]).map((entry) => entry.anchorDirectory)).toEqual([
      layout.outside,
      path.join(layout.home, '.ssh'),
      path.join(layout.project, 'docs'),
    ]);
  });

  it('carries exceptions and provenance', () => {
    const layout = makeLayout();
    const rules = [ruleOf(layout, 'project', 'deny', 'Read(*.env)', ['sample.env'])];
    const specs = fileRuleSpecsOf(rules, [layout.project]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      ruleIndex: 0,
      tool: 'Read',
      access: 'read',
      effect: 'deny',
      specifier: '*.env',
      exceptions: ['sample.env'],
      context: { roots: [layout.project], home: layout.home, settingsRoot: layout.project, effect: 'deny' },
      provenance: { ruleText: 'Read(*.env)', layer: 'project', source: 'project-settings' },
    });
    const [entry] = computeFileRules(rules, [layout.project], null, HOST_RULE_ENFORCEMENT).entries;
    expect(entry?.provenance).toEqual({ ruleText: 'Read(*.env)', layer: 'project', source: 'project-settings' });
    expect(entry?.exceptions).toHaveLength(1);
  });

  it('maps a Write rule to the Edit tool in its spec', () => {
    const layout = makeLayout();
    expect(fileRuleSpecsOf([ruleOf(layout, 'cli', 'allow', 'Write(//tmp/out/**)')], [layout.project])).toEqual([
      expect.objectContaining({ ruleIndex: 0, tool: 'Edit', access: 'write', effect: 'allow', specifier: '//tmp/out/**' }),
    ]);
  });
});

type WideningRow = [label: string, origin: RuleOrigin, widening: boolean, text: (layout: Layout) => string];

const absoluteAllow = (layout: Layout): string => `Edit(/${layout.outside}/**)`;
const homeAllow = (): string => 'Edit(~/n/**)';
const settingsAllow = (): string => 'Edit(/x/**)';
const relativeAllow = (): string => 'Edit(src/**)';

const WIDENING_TABLE: WideningRow[] = [
  ['an absolute allow', 'user', true, absoluteAllow],
  ['an absolute allow', 'cli', true, absoluteAllow],
  ['an absolute allow', 'project', false, absoluteAllow],
  ['an absolute allow', 'local', false, absoluteAllow],
  ['a home allow', 'user', true, homeAllow],
  ['a home allow', 'cli', true, homeAllow],
  ['a home allow', 'project', false, homeAllow],
  ['a home allow', 'local', false, homeAllow],
  ['a settings-root allow', 'user', true, settingsAllow],
  ['a settings-root allow', 'cli', false, settingsAllow],
  ['a settings-root allow', 'project', false, settingsAllow],
  ['a settings-root allow', 'local', false, settingsAllow],
  ['a relative allow', 'user', false, relativeAllow],
  ['a relative allow', 'cli', false, relativeAllow],
  ['a relative allow', 'project', false, relativeAllow],
  ['a relative allow', 'local', false, relativeAllow],
];

describe('widening by layer', () => {
  it.each(WIDENING_TABLE)('%s from the %s layer has widening %s', (_label, origin, widening, text) => {
    const layout = makeLayout();
    for (const dir of [path.join(layout.home, 'n'), path.join(layout.project, 'x'), path.join(layout.project, 'src')]) fs.mkdirSync(dir, { mode: 0o700 });
    const entries = computeFileRules([ruleOf(layout, origin, 'allow', text(layout))], [layout.project], null, HOST_RULE_ENFORCEMENT).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.widening).toBe(widening);
  });
});
