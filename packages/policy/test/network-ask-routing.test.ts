import { testSecretLocations } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import { EMPTY_PROTECTED_SET } from '@momonga/foundation';
import type { NetworkRequest } from '@momonga/foundation';
import { decide } from '@momonga/policy';
import type { Decision, PermissionRule, PolicyTool } from '@momonga/policy';
import type { PermissionMode } from '@momonga/protocol';
import { TEST_SEARCH_PATH, fakeFs, fileRulesFor, makeLayout, ruleIn } from './helpers.ts';

const BASH: PolicyTool = { name: 'Bash', kind: 'execute', sideEffect: 'exec', subjectKind: 'command' };

type Case = { command: string; network: NetworkRequest; mode: PermissionMode; rules?: (layout: ReturnType<typeof makeLayout>) => PermissionRule[] };

const decideCall = async ({ command, network, mode, rules }: Case): Promise<Decision> => {
  const layout = makeLayout();
  const parsed = rules === undefined ? [] : rules(layout);
  return decide({ secretLocations: testSecretLocations(layout.home),
    tool: BASH,
    subject: { kind: 'command', tool: 'Bash', command, network },
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
  });
};

describe('who may answer a network request', () => {
  it.each(['manual', 'acceptEdits', 'auto'] as const)('in %s mode the ask of a command that would run without the network is of the mode and not for a person only', async (mode) => {
    const decision = await decideCall({ command: 'ls', network: 'open', mode });

    expect(decision).toMatchObject({ kind: 'ask', source: 'mode', network: true, reason: 'the command requests unrestricted network access' });
    expect(decision.humanOnly).toBeUndefined();
  });

  it.each(['manual', 'acceptEdits', 'auto'] as const)('in %s mode an ask that stands without the network keeps its own answerer', async (mode) => {
    const decision = await decideCall({ command: 'make', network: 'open', mode });

    expect(decision).toMatchObject({ kind: 'ask', source: 'mode', network: true });
    expect(decision.humanOnly).toBeUndefined();
  });

  it('an ask that only a person may answer stays for a person only when the command also requests the network', async () => {
    const governing = (layout: ReturnType<typeof makeLayout>): PermissionRule[] => [{ ...ruleIn(layout)('ask', 'Bash(make:*)'), layer: 'governance' }];
    const decision = await decideCall({ command: 'make', network: 'open', mode: 'auto', rules: governing });

    expect(decision).toMatchObject({ kind: 'ask', humanOnly: true, network: true });
  });

  it('bypassPermissions grants without asking, as before', async () => {
    expect((await decideCall({ command: 'ls', network: 'open', mode: 'bypassPermissions' })).kind).toBe('allow');
  });
});
