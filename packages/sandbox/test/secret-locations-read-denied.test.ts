import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET, standardSecretLocations, syncPaths } from '@momonga/foundation';
import { describe, expect, it } from 'vitest';
import { alwaysWriteDenied, buildSeatbeltProfile, planBubblewrap } from '@momonga/sandbox';
import type { SandboxPolicy } from '@momonga/sandbox';
import { NEVER_CANCELLED, testPaths, withTempDir } from '@momonga/testkit';
import fs from 'node:fs';
import path from 'node:path';

const policyOf = async (home: string, root: string): Promise<SandboxPolicy> => {
  const denied = await alwaysWriteDenied(home, NEVER_CANCELLED);
  return {
    writableRoots: [root],
    writeDenied: [...denied.subtrees],
    writeDeniedLiterals: [...denied.literals],
    readDenied: [...denied.readDenied],
    protectedSet: EMPTY_PROTECTED_SET,
    fileRules: EMPTY_FILE_RULES,
    network: 'deny',
  };
};

const stage = (context: Parameters<typeof withTempDir>[0]): { home: string; root: string } => {
  const base = syncPaths.canonicalPath(withTempDir(context));
  const home = path.join(base, 'home');
  const root = path.join(base, 'work');
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(home, '.npmrc'), 'token');
  fs.mkdirSync(root);
  return { home, root };
};

describe('the paths every sandboxed command is read-denied', () => {
  it('are the directories of the one shared list of secret locations', async (context) => {
    const { home } = stage(context);

    expect((await alwaysWriteDenied(home, NEVER_CANCELLED)).readDenied).toEqual(standardSecretLocations(home).map((location) => location.directory));
  });

  it('are each denied by the macOS profile', async (context) => {
    const { home, root } = stage(context);
    const { profile, params } = await buildSeatbeltProfile(await policyOf(home, root), {}, testPaths());
    const denied = [...profile.matchAll(/^\(deny file-read\* \(subpath \(param "([^"]+)"\)\)\)$/gm)].map((match) => params[match[1] as string]);

    expect(denied).toEqual(expect.arrayContaining(standardSecretLocations(home).map((location) => location.directory)));
  });

  it('are each masked by the Linux plan where they exist, a folder by an empty folder and a file by an empty file', async (context) => {
    const { home, root } = stage(context);
    const plan = await planBubblewrap(await policyOf(home, root), {}, NEVER_CANCELLED);
    const args = plan.args.join(' ');

    expect(args).toContain(`--tmpfs ${path.join(home, '.ssh')}`);
    expect(args).toContain(`--ro-bind /dev/null ${path.join(home, '.npmrc')}`);
  });
});
