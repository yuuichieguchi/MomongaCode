import { testSecretLocations } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';

import { EMPTY_PROTECTED_SET, syncPaths } from '@momonga/foundation';
import type { NetworkRequest, SandboxNetworkSetting } from '@momonga/foundation';
import { decide, suggestAllowRule, suggestNetworkRule } from '@momonga/policy';

import type { Decision, PermissionRule, PolicyTool } from '@momonga/policy';
import type { RuleEffect } from '@momonga/config';
import type { PermissionMode } from '@momonga/protocol';
import { TEST_SEARCH_PATH, fakeFs, fileRulesFor, makeLayout, ruleIn } from './helpers.ts';


const BASH: PolicyTool = { name: 'Bash', kind: 'execute', sideEffect: 'exec', subjectKind: 'command' };

type Case = { command?: string; network?: NetworkRequest; mode?: PermissionMode; setting?: SandboxNetworkSetting; rules?: (layout: ReturnType<typeof makeLayout>) => PermissionRule[] };

const decideCall = async ({ command = 'npm install', network, mode = 'manual', setting, rules }: Case): Promise<Decision> => {
  const layout = makeLayout();
  const parsed = rules === undefined ? [] : rules(layout);
  return await decide({ secretLocations: testSecretLocations(layout.home),
    tool: BASH,
    subject: { kind: 'command', tool: 'Bash', command, ...(network === undefined ? {} : { network }) },
    mode,
    rules: parsed,
    roots: [layout.project],
    home: layout.home,
    cwd: layout.project,
    fileRules: await fileRulesFor(parsed, [layout.project]),
    protectedSet: EMPTY_PROTECTED_SET,
    fs: fakeFs(),
    searchPath: TEST_SEARCH_PATH,
    isWritable: () => true,
    ...(setting === undefined ? {} : { sandboxNetwork: setting }),
  });
};

const allowNpm = (layout: ReturnType<typeof makeLayout>): PermissionRule[] => [ruleIn(layout)('allow', 'Bash(npm install)')];

describe('a command that requests the network', () => {
  it.each(['manual', 'acceptEdits', 'plan', 'auto'] as const)('asks in %s mode, naming the scope, with the default setting', async (mode) => {
    const decision = await decideCall({ network: 'open', mode });
    expect((await decision).kind).toBe('ask');
    expect((await decision).source).toBe('mode');
    expect((await decision).reason).toContain('the command requests unrestricted network access');
    expect((await decision).humanOnly).toBeUndefined();
  });

  it('asks even when an allow rule covers the command, because a Bash rule grants no network', async () => {
    const decision = await decideCall({ network: 'open', rules: allowNpm });
    expect(decision).toMatchObject({ kind: 'ask', source: 'mode', reason: 'the command requests unrestricted network access' });
    expect((await decideCall({ rules: allowNpm })).kind).toBe('allow');
  });

  it('asks about a read-only command that requests the network', async () => {
    expect(await decideCall({ command: 'ls', network: 'open' })).toMatchObject({ kind: 'ask', reason: 'the command requests unrestricted network access' });
    expect(await decideCall({ command: 'ls' })).toMatchObject({ kind: 'allow', basis: 'read_only' });
  });

  it('keeps the reason of an ask that stands without the network and adds the scope to it', async () => {
    const decision = await decideCall({ command: 'make', network: 'open' });
    expect((await decision).kind).toBe('ask');
    expect((await decision).reason).toBe('shell commands require approval; the command requests unrestricted network access');
  });

  it('names the hosts of a request for named hosts', async () => {
    const decision = await decideCall({ network: { hosts: ['registry.example.org', 'github.example.com:443'] }, rules: allowNpm });
    expect(decision).toMatchObject({ kind: 'ask', reason: 'the command requests network access to github.example.com:443, registry.example.org only (through the sandbox proxy, which carries HTTP and HTTPS; a program that does not use the proxy variables stays without network)' });
    expect(decision.humanOnly).toBeUndefined();
  });

  it('refuses every request when the setting is deny, in every mode', async () => {
    for (const mode of ['manual', 'acceptEdits', 'auto', 'bypassPermissions'] as const) {
      const decision = await decideCall({ network: 'open', mode, setting: 'deny', rules: allowNpm });
      expect(decision).toMatchObject({ kind: 'deny', network: true, reason: 'the command requests unrestricted network access, and the setting sandboxNetwork is deny' });
    }
    expect((await decideCall({ setting: 'deny', rules: allowNpm })).kind).toBe('allow');
  });

  it('grants without asking when the setting is allow, and still asks what would be asked without the network', async () => {
    expect(await decideCall({ network: 'open', setting: 'allow', rules: allowNpm })).toMatchObject({ kind: 'allow', source: 'rule' });
    expect(await decideCall({ command: 'make', network: 'open', setting: 'allow' })).toMatchObject({ kind: 'ask', reason: 'shell commands require approval; the command requests unrestricted network access' });
  });

  it('grants without asking in bypassPermissions mode', async () => {
    expect((await decideCall({ network: 'open', mode: 'bypassPermissions' })).kind).toBe('allow');
  });

  it('lets a deny rule win over every setting', async () => {
    const deny = (layout: ReturnType<typeof makeLayout>): PermissionRule[] => [ruleIn(layout)('deny', 'Bash(npm:*)')];
    for (const setting of ['deny', 'ask', 'allow'] as const) expect(await decideCall({ network: 'open', setting, rules: deny })).toMatchObject({ kind: 'deny', source: 'rule' });
  });

  it('keeps an ask rule as the source of the ask', async () => {
    const ask = (layout: ReturnType<typeof makeLayout>): PermissionRule[] => [ruleIn(layout)('ask', 'Bash(npm:*)')];
    const decision = await decideCall({ network: 'open', rules: ask });
    expect(decision).toMatchObject({ kind: 'ask', source: 'rule' });
    expect((await decision).reason).toContain('; the command requests unrestricted network access');
  });
});

describe('the allow rule suggested for a command that requests the network', () => {
  it('is the command rule when the person is not asked about the network, since a Bash rule grants no network', async () => {
    const layout = makeLayout();
    expect(await suggestAllowRule(BASH, { kind: 'command', tool: 'Bash', command: 'npm install' }, layout.project, syncPaths.resolveCanonicalPath)).toBe('Bash(npm install)');
    expect(await suggestAllowRule(BASH, { kind: 'command', tool: 'Bash', command: 'npm install', network: 'open' }, layout.project, syncPaths.resolveCanonicalPath)).toBe('Bash(npm install)');
  });

  it('is the Network rule of the one host a request names, when the person is asked about the network', () => {
    const command = (network?: NetworkRequest) => ({ kind: 'command' as const, tool: 'Bash', command: 'npm install', ...(network === undefined ? {} : { network }) });
    expect(suggestNetworkRule(command({ hosts: ['Registry.example.org'] }))).toBe('Network(registry.example.org)');
    expect(suggestNetworkRule(command({ hosts: ['registry.example.org:443'] }))).toBe('Network(registry.example.org:443)');
    expect(suggestNetworkRule(command({ hosts: ['a.example.org', 'b.example.org'] }))).toBeUndefined();
    expect(suggestNetworkRule(command('open'))).toBeUndefined();
    expect(suggestNetworkRule(command())).toBeUndefined();
  });
});

describe('a Network rule of the user settings', () => {
  const rulesOf =
    (...rules: Array<[RuleEffect, string]>) =>
    (layout: ReturnType<typeof makeLayout>): PermissionRule[] => [...allowNpm(layout), ...rules.map(([effect, text]) => ruleIn(layout)(effect, text))];

  it('grants every host it covers without asking, and the command is decided as without the network', async () => {
    const rules = rulesOf(['allow', 'Network(*.example.org)'], ['allow', 'Network(github.example.com)']);
    expect(await decideCall({ network: { hosts: ['registry.example.org', 'GitHub.example.com:443'] }, rules })).toMatchObject({ kind: 'allow', source: 'rule' });
    const make = await decideCall({ command: 'make', network: { hosts: ['registry.example.org'] }, rules });
    expect(make).toMatchObject({ kind: 'ask', source: 'mode' });
    expect(make.reason).toMatch(/^shell commands require approval; the command requests network access to registry\.example\.org only/);
    expect(make.network).toBeUndefined();
  });

  it('asks as before for a host it does not cover: the apex of a suffix, another name, a port it does not hold, or an open request', async () => {
    const rules = rulesOf(['allow', 'Network(*.example.org)'], ['allow', 'Network(github.example.com:443)']);
    for (const network of [{ hosts: ['example.org'] }, { hosts: ['registry.example.org', 'other.test'] }, { hosts: ['github.example.com'] }, { hosts: ['github.example.com:22'] }, 'open'] as const) {
      expect(await decideCall({ network, rules })).toMatchObject({ kind: 'ask', source: 'mode', network: true });
    }
  });

  it('denies a host a deny rule covers, naming the rule, in every setting and mode', async () => {
    const rules = rulesOf(['allow', 'Network(*.example.org)'], ['deny', 'Network(tracker.example.org)']);
    for (const setting of ['ask', 'allow'] as const) {
      for (const mode of ['manual', 'bypassPermissions'] as const) {
        const decision = await decideCall({ network: { hosts: ['tracker.example.org'] }, rules, setting, mode });
        expect(decision).toMatchObject({ kind: 'deny', source: 'rule', network: true });
        expect(decision.rule?.text).toBe('Network(tracker.example.org)');
      }
    }
  });

  it('asks for a host an ask rule covers, naming the rule, even when an allow rule covers it too', async () => {
    const decision = await decideCall({ network: { hosts: ['registry.example.org'] }, rules: rulesOf(['allow', 'Network(*.example.org)'], ['ask', 'Network(registry.example.org)']), setting: 'allow' });
    expect(decision).toMatchObject({ kind: 'ask', source: 'rule', network: true });
    expect(decision.rule?.text).toBe('Network(registry.example.org)');
    expect(decision.reason).toContain('the command requests network access to registry.example.org only');
  });
});
