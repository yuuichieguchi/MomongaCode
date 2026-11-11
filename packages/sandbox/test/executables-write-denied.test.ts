import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET, momongaLayout, syncPaths } from '@momonga/foundation';
import { alwaysWriteDenied, buildSeatbeltProfile, planBubblewrap, nodeFilesystemPort } from '@momonga/sandbox';
import type { SandboxPolicy } from '@momonga/sandbox';
import { withTempDir, NEVER_CANCELLED, testPaths, testKernelLock } from '@momonga/testkit';

const executablesOf = (home: string): string => (momongaLayout(home) as unknown as { executables: string }).executables;

const policyFor = async (home: string): Promise<SandboxPolicy> => {
  const denied = await alwaysWriteDenied(home, NEVER_CANCELLED);
  return {
    writableRoots: [home],
    writeDenied: [...denied.subtrees],
    protectedSet: EMPTY_PROTECTED_SET,
    writeDeniedLiterals: [...denied.literals],
    fileRules: EMPTY_FILE_RULES,
    readDenied: [],
    network: 'deny',
  };
};

describe('the executables area is always write-denied, like ~/.momonga, and stays readable', () => {
  it('lists the area beside the momonga root and the keychains, and neither the cache base nor its tmp area', async (context) => {
    const home = fs.realpathSync(withTempDir(context));
    const layout = momongaLayout(home);
    const denied = await alwaysWriteDenied(home, NEVER_CANCELLED);
    expect(denied.subtrees).toContain(layout.root);
    expect(denied.subtrees).toContain(layout.keychains);
    expect(denied.subtrees).toContain(executablesOf(home));
    expect(denied.subtrees).not.toContain(layout.cacheBase);
    expect(denied.subtrees).not.toContain(layout.tmp.root);
  });

  it('puts the area directly under the cache base, beside the tmp area', (context) => {
    const home = fs.realpathSync(withTempDir(context));
    const layout = momongaLayout(home);
    expect(executablesOf(home)).toBe(path.join(layout.cacheBase, 'executables'));
    expect(path.dirname(layout.tmp.root)).toBe(layout.cacheBase);
  });

  it('denies writes to the area in the Seatbelt profile, and does not deny reads of it', async (context) => {
    const home = fs.realpathSync(withTempDir(context));
    const area = syncPaths.canonicalPath(executablesOf(home));
    const { profile, params } = await buildSeatbeltProfile(await policyFor(home), {}, testPaths());
    const denied = [...profile.matchAll(/^\(deny file-write\* \(subpath \(param "([^"]+)"\)\)\)$/gm)].map((match) => params[match[1] ?? '']);
    expect(denied).toContain(area);
    const readDenied = [...profile.matchAll(/^\(deny file-read\* \(subpath \(param "([^"]+)"\)\)\)$/gm)].map((match) => params[match[1] ?? '']);
    expect(readDenied).not.toContain(area);
  });

  it('mounts the area read-only in the bubblewrap plan and does not hide it', async (context) => {
    const home = fs.realpathSync(withTempDir(context));
    const area = syncPaths.canonicalPath(executablesOf(home));
    fs.mkdirSync(area, { recursive: true });
    const { args } = await planBubblewrap(await policyFor(home), { cwd: home }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
    const triples = args.flatMap((value, index) => (value === '--ro-bind' ? [args.slice(index, index + 3).join(' ')] : []));
    expect(triples).toContain(`--ro-bind ${area} ${area}`);
    expect(args.flatMap((value, index) => (value === '--tmpfs' ? [args[index + 1]] : []))).not.toContain(area);
  });
});
