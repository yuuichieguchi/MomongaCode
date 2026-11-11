import { describe, expect, it, vi } from 'vitest';
import { appendPermissionRule, createUserSettingsCache, loadMcpServers, loadSettings, loadUserSettings, noKeptRecords, systemFileLockPorts } from '@momonga/config';
import { makeTree, trusting } from './helpers.ts';
import { testKernelLock } from '@momonga/testkit';

const NEVER_ABORTED = new AbortController().signal;

const layoutCalls = vi.hoisted(() => [] as unknown[][]);

vi.mock('@momonga/foundation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@momonga/foundation')>();
  return {
    ...actual,
    momongaLayout: (...args: Parameters<typeof actual.momongaLayout>) => {
      layoutCalls.push(args);
      return actual.momongaLayout(...args);
    },
  };
});

const expectExplicitEnv = (): void => {
  expect(layoutCalls.length).toBeGreaterThan(0);
  for (const call of layoutCalls) {
    expect(call).toHaveLength(3);
    expect(call[1]).toBe(process.platform);
    if (process.platform === 'darwin') expect(call[2]).toEqual({});
    expect(call[2]).not.toBe(process.env);
  }
};

describe('config passes an explicit env to momongaLayout', () => {
  it('in loadSettings', async () => {
    layoutCalls.length = 0;
    const tree = makeTree();
    await loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expectExplicitEnv();
  });

  it('in loadUserSettings and the user settings cache', async () => {
    layoutCalls.length = 0;
    const tree = makeTree();
    await loadUserSettings({ home: tree.home });
    createUserSettingsCache({ home: tree.home, onWarning: () => {}, keptRecords: noKeptRecords }).get();
    expectExplicitEnv();
  });

  it('in loadMcpServers and appendPermissionRule', async () => {
    layoutCalls.length = 0;
    const tree = makeTree();
    await loadMcpServers({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, trust: trusting(tree), env: {} });
    await appendPermissionRule({ lock: testKernelLock(), ports: systemFileLockPorts, home: tree.home, projectDir: tree.project, rule: 'Bash(ls)', effect: 'allow', signal: NEVER_ABORTED });
    expectExplicitEnv();
  });
});
