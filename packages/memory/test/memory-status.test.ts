import { describe, expect, it } from 'vitest';
import { EvidenceOutsideRootError, memoryStatus } from '@momonga/memory';
import type { EvidencePorts } from '@momonga/memory';
import type { MemoryEvidence } from '@momonga/protocol';

const PROJECT = '/work/a';
const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

const file = (filePath: string, sha256 = HASH, project = PROJECT): MemoryEvidence => ({ kind: 'file', project, path: filePath, sha256 });
const commit: MemoryEvidence = { kind: 'commit', sha: COMMIT };
const check: MemoryEvidence = { kind: 'check', runId: 'r1', callId: 'c1', seq: 4, command: 'npm test', exitCode: 0 };

const portsWith = (files: Record<string, string>, ancestorAnswer: boolean | 'unknown' = true) => {
  const ancestor = ancestorAnswer === 'unknown' ? undefined : ancestorAnswer;
  const hashed: string[] = [];
  const asked: string[] = [];
  const ports: EvidencePorts = {
    hashFile: async (target) => {
      hashed.push(target);
      return files[target];
    },
    isAncestor: async (sha) => {
      asked.push(sha);
      return ancestor;
    },
  };
  return { ports, hashed, asked };
};

const statusOf = (evidence: MemoryEvidence[], ports: EvidencePorts, trusted = true) => memoryStatus({ evidence }, { project: PROJECT, trusted, ports });

describe('memoryStatus', () => {
  it('is verified when every hash matches, resolving the path against the project root', async () => {
    const { ports, hashed } = portsWith({ '/work/a/src/a.ts': HASH, '/work/a/b.ts': OTHER_HASH });
    await expect(statusOf([file('src/a.ts'), file('b.ts', OTHER_HASH)], ports)).resolves.toBe('verified');
    expect(hashed.sort()).toEqual(['/work/a/b.ts', '/work/a/src/a.ts']);
  });

  it('is verified with matching files, an ancestor commit and a check', async () => {
    await expect(statusOf([file('a.ts'), commit, check], portsWith({ '/work/a/a.ts': HASH }).ports)).resolves.toBe('verified');
  });

  it('is stale when one hash of several differs', async () => {
    const { ports } = portsWith({ '/work/a/a.ts': HASH, '/work/a/b.ts': OTHER_HASH });
    await expect(statusOf([file('a.ts'), file('b.ts')], ports)).resolves.toBe('stale');
  });

  it('is stale when a file is gone', async () => {
    await expect(statusOf([file('a.ts')], portsWith({}).ports)).resolves.toBe('stale');
  });

  it('is unverifiable when the port reports a path that resolves outside the root, which is not a missing file', async () => {
    const ports: EvidencePorts = {
      hashFile: async (target) => {
        throw new EvidenceOutsideRootError(target);
      },
      isAncestor: async () => true,
    };
    await expect(statusOf([file('link')], ports)).resolves.toBe('unverifiable');
  });

  it('lets a contradiction outrank an entry that cannot be checked', async () => {
    const { ports } = portsWith({ '/work/a/a.ts': OTHER_HASH });
    await expect(statusOf([file('a.ts'), file('b.ts', HASH, '/work/b')], ports)).resolves.toBe('stale');
  });

  it('stays verified when a commit is not an ancestor and every hash matches, because a squash or a rebase does that and the commit is provenance', async () => {
    const { ports, asked } = portsWith({ '/work/a/a.ts': HASH }, false);
    await expect(statusOf([file('a.ts'), commit], ports)).resolves.toBe('verified');
    expect(asked).toEqual([]);
  });

  it('stays verified when the commit check could not run, because file entries alone decide', async () => {
    const { ports, asked } = portsWith({ '/work/a/a.ts': HASH }, 'unknown');
    await expect(statusOf([file('a.ts'), commit], ports)).resolves.toBe('verified');
    expect(asked).toEqual([]);
  });

  it('is stale when a hash differs, whatever the commit says', async () => {
    await expect(statusOf([file('a.ts'), commit], portsWith({ '/work/a/a.ts': OTHER_HASH }, true).ports)).resolves.toBe('stale');
  });

  it('is stale when a file is gone even though the commit is not an ancestor', async () => {
    await expect(statusOf([file('a.ts'), commit], portsWith({}, false).ports)).resolves.toBe('stale');
  });

  it('is unverifiable in an untrusted folder, and touches nothing', async () => {
    const { ports, hashed, asked } = portsWith({ '/work/a/a.ts': HASH });
    await expect(statusOf([file('a.ts'), commit], ports, false)).resolves.toBe('unverifiable');
    expect(hashed).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('is unverifiable for evidence of another project, and never reads that project', async () => {
    const { ports, hashed } = portsWith({ '/work/b/a.ts': HASH });
    await expect(statusOf([file('a.ts', HASH, '/work/b')], ports)).resolves.toBe('unverifiable');
    expect(hashed).toEqual([]);
  });

  it.each([
    ['a parent traversal', '../b/secret.txt'],
    ['a nested traversal', 'src/../../b/secret.txt'],
    ['an absolute path', '/etc/passwd'],
  ])('never hashes %s, because a path stays inside its project root', async (_name, target) => {
    const { ports, hashed } = portsWith({ '/work/b/secret.txt': HASH, '/etc/passwd': HASH });
    await expect(statusOf([file(target)], ports)).resolves.toBe('unverifiable');
    expect(hashed).toEqual([]);
  });

  it('allows .. that stays inside the root', async () => {
    const { ports } = portsWith({ '/work/a/a.ts': HASH });
    await expect(statusOf([file('src/../a.ts')], ports)).resolves.toBe('verified');
  });

  it('is unbound with no evidence', async () => {
    await expect(statusOf([], portsWith({}).ports)).resolves.toBe('unbound');
  });

  it.each<[string, MemoryEvidence[]]>([
    ['a commit that is an ancestor', [commit]],
    ['a passing check', [check]],
    ['both', [commit, check]],
  ])('is unbound with only %s that can be checked, because provenance does not say the fact still holds', async (_name, evidence) => {
    await expect(statusOf(evidence, portsWith({}).ports)).resolves.toBe('unbound');
  });

  it('is unverifiable with only a commit that is not an ancestor, and never stale', async () => {
    await expect(statusOf([commit], portsWith({}, false).ports)).resolves.toBe('unverifiable');
    await expect(statusOf([commit, check], portsWith({}, false).ports)).resolves.toBe('unverifiable');
  });

  it('is unverifiable with only a commit that cannot be checked', async () => {
    await expect(statusOf([commit], portsWith({}, 'unknown').ports)).resolves.toBe('unverifiable');
  });

  it('is unverifiable with only a commit in an untrusted folder, and asks nothing', async () => {
    const { ports, asked } = portsWith({}, true);
    await expect(statusOf([commit], ports, false)).resolves.toBe('unverifiable');
    expect(asked).toEqual([]);
  });
});
