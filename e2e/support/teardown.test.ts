import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIRST_GENERATION, generationLayout, isProcessAlive, momongaLayout } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, startLockHolder, withTempDir } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { OWNER_FILE, ROOT_PREFIX, ownerRecord } from '../../packages/cli/src/eval/context-host.ts';
import { KEPT_HOME_FILE_NAME } from './home.ts';
import { runE2eTeardown } from './teardown.ts';

const RUN = 'ab12';
const OTHER_RUN = 'cd34';

const directoryWithSupervisor = async (context: CleanupContext, parent: string, name: string): Promise<{ root: string; holder: number }> => {
  const root = path.join(parent, name);
  fs.mkdirSync(root, { mode: 0o700 });
  const { supervisor } = generationLayout(root, FIRST_GENERATION).locks;
  fs.mkdirSync(path.dirname(supervisor), { recursive: true, mode: 0o700 });
  const holder = await startLockHolder(context, supervisor);
  return { root, holder: holder.pid };
};

describe('runE2eTeardown', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('stops the supervisor of a leaked home before it removes the directory', async (context) => {
    const tmpRoot = withTempDir(context);
    const leaked = await directoryWithSupervisor(context, tmpRoot, `mme-${RUN}-aaaaaa`);

    await expect(runE2eTeardown({ tmpRoot, run: RUN, evalBase: withTempDir(context), report: () => undefined })).rejects.toThrow('e2e leak guard');

    expect(isProcessAlive(leaked.holder)).toBe(false);
    expect(fs.existsSync(leaked.root)).toBe(false);
  });

  it('stops and removes the eval roots owned by a home of this run, and leaves the eval roots of another home alone', async (context) => {
    const tmpRoot = withTempDir(context);
    const evalBase = withTempDir(context);
    const ownHome = path.join(tmpRoot, `mme-${RUN}-bbbbbb`);
    const otherHome = path.join(tmpRoot, `mme-${OTHER_RUN}-cccccc`);
    const own = await directoryWithSupervisor(context, evalBase, `${ROOT_PREFIX}own`);
    const foreign = await directoryWithSupervisor(context, evalBase, `${ROOT_PREFIX}foreign`);
    fs.writeFileSync(path.join(own.root, OWNER_FILE), ownerRecord({ pid: 1, home: ownHome }));
    fs.writeFileSync(path.join(foreign.root, OWNER_FILE), ownerRecord({ pid: 1, home: otherHome }));

    await expect(runE2eTeardown({ tmpRoot, run: RUN, evalBase, report: () => undefined })).rejects.toThrow('e2e leak guard');

    expect(isProcessAlive(own.holder)).toBe(false);
    expect(fs.existsSync(own.root)).toBe(false);
    expect(isProcessAlive(foreign.holder)).toBe(true);
    expect(fs.existsSync(foreign.root)).toBe(true);
  });

  it('leaves the home a failed test kept and names it, without counting it as a leak', async (context) => {
    const tmpRoot = withTempDir(context);
    const kept = path.join(tmpRoot, `mme-${RUN}-dddddd`);
    fs.mkdirSync(kept, { mode: 0o700 });
    fs.writeFileSync(path.join(kept, KEPT_HOME_FILE_NAME), 'the failing test\n');
    const lines: string[] = [];

    await runE2eTeardown({ tmpRoot, run: RUN, evalBase: withTempDir(context), report: (line) => lines.push(line) });

    expect(fs.existsSync(kept)).toBe(true);
    expect(lines).toEqual([`e2e teardown: kept the home of the failed test the failing test at ${kept}`]);
  });
});
