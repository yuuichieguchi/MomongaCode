import { describe, expect, it, vi } from 'vitest';
import { appendPermissionRule, createUserSettingsCache, loadMcpServers, loadSettings, loadUserSettings, noKeptRecords, systemFileLockPorts } from '@momonga/config';
import { makeTree, trusting } from './helpers.ts';
import { testKernelLock } from '@momonga/testkit';

const NEVER_ABORTED = new AbortController().signal;

const layoutCalls = vi.hoisted(() => ({ whole: [] as unknown[][], underHome: [] as unknown[][] }));

vi.mock('@momonga/foundation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@momonga/foundation')>();
  return {
    ...actual,
    momongaLayout: (...args: Parameters<typeof actual.momongaLayout>) => {
      layoutCalls.whole.push(args);
      return actual.momongaLayout(...args);
    },
    homeLayout: (...args: Parameters<typeof actual.homeLayout>) => {
      layoutCalls.underHome.push(args);
      return actual.homeLayout(...args);
    },
  };
});

const forget = (): void => {
  layoutCalls.whole.length = 0;
  layoutCalls.underHome.length = 0;
};

const expectNoEnvironmentOfItsOwn = (): void => {
  expect(layoutCalls.whole.length + layoutCalls.underHome.length).toBeGreaterThan(0);
  for (const call of layoutCalls.underHome) expect(call).toEqual([call[0], process.platform]);
  for (const call of layoutCalls.whole) {
    expect(call).toHaveLength(3);
    expect(call[1]).toBe(process.platform);
    expect(call[2]).toBe(process.env);
  }
};

describe('config names the directories under the home without an environment, and the key store with the environment of its process', () => {
  it('in loadSettings', async () => {
    forget();
    const tree = makeTree();
    await loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expectNoEnvironmentOfItsOwn();
  });

  it('in loadUserSettings and the user settings cache', async () => {
    forget();
    const tree = makeTree();
    await loadUserSettings({ home: tree.home });
    createUserSettingsCache({ home: tree.home, onWarning: () => {}, keptRecords: noKeptRecords }).get();
    expectNoEnvironmentOfItsOwn();
  });

  it('in loadMcpServers and appendPermissionRule', async () => {
    forget();
    const tree = makeTree();
    await loadMcpServers({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, trust: trusting(tree), env: {} });
    await appendPermissionRule({ lock: testKernelLock(), ports: systemFileLockPorts, home: tree.home, projectDir: tree.project, rule: 'Bash(ls)', effect: 'allow', signal: NEVER_ABORTED });
    expectNoEnvironmentOfItsOwn();
  });
});
