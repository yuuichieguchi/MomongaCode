import { describe, expect, it } from 'vitest';
import { discoverRepository } from '../src/repository.ts';
import type { RepositoryPorts } from '../src/repository.ts';

const portsWith = (overrides: Record<string, unknown>): RepositoryPorts =>
  ({
    canonicalise: (absolute: string) => ({ ok: true, path: absolute }),
    readEntry: () => ({ kind: 'absent' }),
    readHead: () => ({ kind: 'invalid' }),
    isSearchable: () => false,
    ...overrides,
  }) as unknown as RepositoryPorts;

const VALID_HEAD = { kind: 'text', text: 'ref: refs/heads/main\n' };

describe('a missing entry means no repository', () => {
  it('control: every entry missing is no repository', async () => {
    expect(await discoverRepository('/w', portsWith({}))).toEqual({ found: false });
  });

  it('an invalid HEAD passes over the layout', async () => {
    expect(await discoverRepository('/w', portsWith({ readHead: () => ({ kind: 'invalid' }), isSearchable: () => true }))).toEqual({ found: false });
  });
});

describe('a NUL byte in a pointer file ends the text, as git does', () => {
  const pathChecked = (absolute: string) => {
    if (absolute.includes('\0')) throw new TypeError('path must be a string without null bytes');
    return { ok: true, path: absolute };
  };

  it('in commondir', async () => {
    const ports = portsWith({
      canonicalise: pathChecked,
      readHead: () => VALID_HEAD,
      isSearchable: () => true,
      readEntry: (absolute: string) => (absolute === '/w/commondir' ? { kind: 'file', text: '../real\0x\n' } : { kind: 'absent' }),
    });
    expect(await discoverRepository('/w', ports)).toEqual({ found: true, hit: { directory: '/w', entry: 'bare', gitDirectories: ['/w', '/real'] } });
  });

  it('in a .git file', async () => {
    const ports = portsWith({
      canonicalise: pathChecked,
      readHead: () => VALID_HEAD,
      isSearchable: () => true,
      readEntry: (absolute: string) => (absolute === '/w/.git' ? { kind: 'file', text: 'gitdir: ../real\0x\n' } : { kind: 'absent' }),
    });
    expect(await discoverRepository('/w', ports)).toEqual({ found: true, hit: { directory: '/w', entry: 'dotgit', gitDirectories: ['/real'] } });
  });
});
