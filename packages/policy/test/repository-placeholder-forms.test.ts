import { describe, expect, it } from 'vitest';
import { discoverRepository } from '../src/repository.ts';
import type { RepositoryPorts } from '../src/repository.ts';

const VALID_HEAD = { kind: 'text', text: 'ref: refs/heads/main\n' };

const portsOf = (entries: Readonly<Record<string, unknown>>, gitDirectories: readonly string[]): RepositoryPorts =>
  ({
    canonicalise: (absolute: string) => ({ ok: true, path: absolute }),
    readEntry: (absolute: string) => entries[absolute] ?? { kind: 'absent' },
    readHead: (absolute: string) => (gitDirectories.some((directory) => absolute === `${directory}/HEAD`) ? VALID_HEAD : { kind: 'invalid' }),
    isSearchable: (absolute: string) => gitDirectories.some((directory) => absolute === `${directory}/objects` || absolute === `${directory}/refs`),
  }) as unknown as RepositoryPorts;

describe('discoverRepository reads the placeholder forms as git does', () => {
  it('resolves a commondir that holds a dot and a newline to the git directory itself', () => {
    const ports = portsOf({ '/w/.git': { kind: 'directory', canonical: '/w/.git' }, '/w/.git/commondir': { kind: 'file', text: '.\n' } }, ['/w/.git']);
    expect(discoverRepository('/w', ports)).toEqual({ found: true, hit: { directory: '/w', entry: 'dotgit', gitDirectories: ['/w/.git'] } });
  });

  it('passes over an empty .git directory and finds the repository of the parent, as for an absent .git', () => {
    const ports = portsOf({ '/p/sub/.git': { kind: 'directory', canonical: '/p/sub/.git' }, '/p/.git': { kind: 'directory', canonical: '/p/.git' } }, ['/p/.git']);
    const absent = portsOf({ '/p/.git': { kind: 'directory', canonical: '/p/.git' } }, ['/p/.git']);
    const expected = { found: true, hit: { directory: '/p', entry: 'dotgit', gitDirectories: ['/p/.git'] } };
    expect(discoverRepository('/p/sub', absent)).toEqual(expected);
    expect(discoverRepository('/p/sub', ports)).toEqual(expected);
  });
});
