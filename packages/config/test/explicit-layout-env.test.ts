import { describe, expect, it, vi } from 'vitest';
import { createUserSettingsCache, loadSettings, loadUserSettings, noKeptRecords, pendingProjectItems, readProjectCheck, settingsWriterPorts, writeProjectMcpServer } from '@momonga/config';
import type { LayoutEnvironment } from '@momonga/foundation';
import { makeTree, trusting, userSettingsPath, writeJson } from './helpers.ts';
import type { Tree } from './helpers.ts';
import { testKernelLock } from '@momonga/testkit';

const NEVER_ABORTED = new AbortController().signal;
const FAKE_ENV: LayoutEnvironment = { XDG_DATA_HOME: '/fake/xdg-data', APPDATA: '/fake/appdata' };

const layoutCalls = vi.hoisted(() => ({ whole: [] as unknown[][] }));

vi.mock('@momonga/foundation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@momonga/foundation')>();
  return {
    ...actual,
    momongaLayout: (...args: Parameters<typeof actual.momongaLayout>) => {
      layoutCalls.whole.push(args);
      return actual.momongaLayout(...args);
    },
  };
});

const withKeyStoreReached = (tree: Tree): void => {
  writeJson(userSettingsPath(tree), { sandboxUnixSockets: { allow: ['/var/run/agent'] } });
};

const expectKeyStoreFromArgument = (env: LayoutEnvironment): void => {
  expect(layoutCalls.whole.length).toBeGreaterThan(0);
  for (const call of layoutCalls.whole) {
    expect(call).toHaveLength(3);
    expect(call[1]).toBe(process.platform);
    expect(call[2]).toBe(env);
  }
};

describe('config takes the key store from the environment it is given, never from its own process', () => {
  it('in loadSettings', async () => {
    layoutCalls.whole.length = 0;
    const tree = makeTree();
    withKeyStoreReached(tree);
    await loadSettings({ env: FAKE_ENV, signal: NEVER_ABORTED, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expectKeyStoreFromArgument(FAKE_ENV);
  });

  it('in loadUserSettings and the user settings cache', async () => {
    layoutCalls.whole.length = 0;
    const tree = makeTree();
    withKeyStoreReached(tree);
    await loadUserSettings({ env: FAKE_ENV, home: tree.home, signal: NEVER_ABORTED });
    expectKeyStoreFromArgument(FAKE_ENV);
    layoutCalls.whole.length = 0;
    await createUserSettingsCache({ env: FAKE_ENV, home: tree.home, onWarning: () => {}, keptRecords: noKeptRecords }).load(NEVER_ABORTED);
    expectKeyStoreFromArgument(FAKE_ENV);
  });

  it('in pendingProjectItems, writeProjectMcpServer and readProjectCheck', async () => {
    layoutCalls.whole.length = 0;
    const tree = makeTree();
    withKeyStoreReached(tree);
    await pendingProjectItems({ env: FAKE_ENV, home: tree.home, projectDir: tree.project, trust: trusting(tree), agents: async () => [], signal: NEVER_ABORTED });
    expectKeyStoreFromArgument(FAKE_ENV);
    layoutCalls.whole.length = 0;
    await writeProjectMcpServer(tree.project, 'docs', { type: 'stdio', command: 'npx' }, { env: FAKE_ENV, home: tree.home, trust: trusting(tree), ...settingsWriterPorts(tree.home, { lock: testKernelLock(), signal: NEVER_ABORTED }) });
    expectKeyStoreFromArgument(FAKE_ENV);
    layoutCalls.whole.length = 0;
    await readProjectCheck({ env: FAKE_ENV, home: tree.home, projectDir: tree.project, signal: NEVER_ABORTED });
    expectKeyStoreFromArgument(FAKE_ENV);
  });
});
