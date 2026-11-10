import { describe, expect, it } from 'vitest';
import { EMPTY_PROTECTED_SET, resolveCanonicalPath } from '@momonga/foundation';
import type { NetworkRequest, SandboxNetworkSetting } from '@momonga/foundation';
import { decide, suggestAllowRule } from '@momonga/policy';
import type { Decision, PermissionRule, PolicyTool } from '@momonga/policy';
import type { PermissionMode } from '@momonga/protocol';
import { TEST_SEARCH_PATH, fakeFs, fileRulesFor, makeLayout, ruleIn } from './helpers.ts';

const BASH: PolicyTool = { name: 'Bash', kind: 'execute', sideEffect: 'exec', subjectKind: 'command' };

type Case = { command?: string; network?: NetworkRequest; mode?: PermissionMode; setting?: SandboxNetworkSetting; rules?: (layout: ReturnType<typeof makeLayout>) => PermissionRule[] };

const decideCall = ({ command = 'npm install', network, mode = 'manual', setting, rules }: Case): Decision => {
  const layout = makeLayout();
  const parsed = rules === undefined ? [] : rules(layout);
  return decide({
    tool: BASH,
    subject: { kind: 'command', tool: 'Bash', command, ...(network === undefined ? {} : { network }) },
    mode,
    rules: parsed,
    roots: [layout.project],
    home: layout.home,
    cwd: layout.project,
    fileRules: fileRulesFor(parsed, [layout.project]),
    protectedSet: EMPTY_PROTECTED_SET,
    fs: fakeFs(),
    searchPath: TEST_SEARCH_PATH,
    isWritable: () => true,
    ...(setting === undefined ? {} : { sandboxNetwork: setting }),
  });
};

const allowNpm = (layout: ReturnType<typeof makeLayout>): PermissionRule[] => [ruleIn(layout)('allow', 'Bash(npm install)')];

describe('a command that requests the network', () => {
  it.each(['manual', 'acceptEdits', 'plan', 'auto'] as const)('asks a person in %s mode, naming the scope, with the default setting', (mode) => {
    const decision = decideCall({ network: 'open', mode });
    expect(decision.kind).toBe('ask');
    expect(decision.source).toBe('mode');
    expect(decision.reason).toContain('the command requests unrestricted network access');
    expect(decision.humanOnly).toBe(true);
  });

  it('asks even when an allow rule covers the command, because a network grant is never saved', () => {
    const decision = decideCall({ network: 'open', rules: allowNpm });
    expect(decision).toMatchObject({ kind: 'ask', source: 'mode', reason: 'the command requests unrestricted network access' });
    expect(decideCall({ rules: allowNpm }).kind).toBe('allow');
  });

  it('asks about a read-only command that requests the network', () => {
    expect(decideCall({ command: 'ls', network: 'open' })).toMatchObject({ kind: 'ask', reason: 'the command requests unrestricted network access' });
    expect(decideCall({ command: 'ls' })).toMatchObject({ kind: 'allow', basis: 'read_only' });
  });

  it('keeps the reason of an ask that stands without the network and adds the scope to it', () => {
    const decision = decideCall({ command: 'make', network: 'open' });
    expect(decision.kind).toBe('ask');
    expect(decision.reason).toBe('shell commands require approval; the command requests unrestricted network access');
  });

  it('names the hosts of a request for named hosts', () => {
    const decision = decideCall({ network: { hosts: ['registry.example.org', 'github.example.com:443'] }, rules: allowNpm });
    expect(decision).toMatchObject({ kind: 'ask', reason: 'the command requests network access to github.example.com:443, registry.example.org only (through the sandbox proxy, which carries HTTP and HTTPS; a program that does not use the proxy variables stays without network)', humanOnly: true });
  });

  it('refuses every request when the setting is deny, in every mode', () => {
    for (const mode of ['manual', 'acceptEdits', 'auto', 'bypassPermissions'] as const) {
      const decision = decideCall({ network: 'open', mode, setting: 'deny', rules: allowNpm });
      expect(decision).toMatchObject({ kind: 'deny', network: true, reason: 'the command requests unrestricted network access, and the setting sandboxNetwork is deny' });
    }
    expect(decideCall({ setting: 'deny', rules: allowNpm }).kind).toBe('allow');
  });

  it('grants without asking when the setting is allow, and still asks what would be asked without the network', () => {
    expect(decideCall({ network: 'open', setting: 'allow', rules: allowNpm })).toMatchObject({ kind: 'allow', source: 'rule' });
    expect(decideCall({ command: 'make', network: 'open', setting: 'allow' })).toMatchObject({ kind: 'ask', reason: 'shell commands require approval; the command requests unrestricted network access' });
  });

  it('grants without asking in bypassPermissions mode', () => {
    expect(decideCall({ network: 'open', mode: 'bypassPermissions' }).kind).toBe('allow');
  });

  it('lets a deny rule win over every setting', () => {
    const deny = (layout: ReturnType<typeof makeLayout>): PermissionRule[] => [ruleIn(layout)('deny', 'Bash(npm:*)')];
    for (const setting of ['deny', 'ask', 'allow'] as const) expect(decideCall({ network: 'open', setting, rules: deny })).toMatchObject({ kind: 'deny', source: 'rule' });
  });

  it('keeps an ask rule as the source of the ask', () => {
    const ask = (layout: ReturnType<typeof makeLayout>): PermissionRule[] => [ruleIn(layout)('ask', 'Bash(npm:*)')];
    const decision = decideCall({ network: 'open', rules: ask });
    expect(decision).toMatchObject({ kind: 'ask', source: 'rule' });
    expect(decision.reason).toContain('; the command requests unrestricted network access');
  });
});

describe('the allow rule suggested for a command that requests the network', () => {
  it('is none, because the grant is not saved', () => {
    const layout = makeLayout();
    expect(suggestAllowRule(BASH, { kind: 'command', tool: 'Bash', command: 'npm install' }, layout.project, resolveCanonicalPath)).toBe('Bash(npm install)');
    expect(suggestAllowRule(BASH, { kind: 'command', tool: 'Bash', command: 'npm install', network: 'open' }, layout.project, resolveCanonicalPath)).toBeUndefined();
    expect(suggestAllowRule(BASH, { kind: 'command', tool: 'Bash', command: 'npm install', network: { hosts: ['registry.example.org'] } }, layout.project, resolveCanonicalPath)).toBeUndefined();
  });
});
