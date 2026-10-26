import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSeatbeltProfile, defaultProtectedPaths } from '@momonga/sandbox';
import type { SandboxPolicy } from '@momonga/sandbox';
import { makeTempDir } from './helpers.ts';

const created: string[] = [];

function tempDir(): string {
  const dir = makeTempDir();
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function policyFor(root: string, overrides: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return { writableRoots: [root], writeDenied: [], writeDeniedLiterals: [], readDenied: [], network: 'deny', ...overrides };
}

function paramNamesReferenced(profile: string): string[] {
  return [...profile.matchAll(/\(param "([^"]+)"\)/g)].map((match) => match[1] ?? '');
}

describe('buildSeatbeltProfile', () => {
  it('starts with version 1 and deny default', () => {
    const { profile } = buildSeatbeltProfile(policyFor(tempDir()));
    expect(profile).toMatch(/^\(version 1\)/);
    expect(profile).toContain('(deny default)');
  });

  it('never interpolates paths into the profile text', () => {
    const base = tempDir();
    const root = fs.realpathSync(base);
    const secret = path.join(root, 'secret');
    fs.mkdirSync(secret);
    const { profile, params } = buildSeatbeltProfile(
      policyFor(root, { writeDenied: [path.join(root, '.git', 'hooks')], readDenied: [secret] }),
    );
    expect(profile).not.toContain(root);
    expect(profile).not.toContain(path.basename(base));
    expect(Object.values(params)).toContain(root);
    expect(Object.values(params)).toContain(secret);
    expect(Object.values(params)).toContain(path.join(root, '.git', 'hooks'));
  });

  it('keeps hostile characters out of the profile and passes them verbatim as params', () => {
    const parent = fs.realpathSync(tempDir());
    const root = path.join(parent, 'a"b)c;d\n(allow default)-日本');
    fs.mkdirSync(root);
    const { profile, params } = buildSeatbeltProfile(policyFor(root));
    expect(profile).not.toContain('日本');
    expect(profile).not.toContain('a"b');
    expect(profile.match(/\(allow default\)/g)).toBeNull();
    expect(Object.values(params)).toContain(root);
  });

  it('references every param it defines and defines every param it references', () => {
    const root = fs.realpathSync(tempDir());
    const secret = path.join(root, 'secret');
    fs.mkdirSync(secret);
    const { profile, params } = buildSeatbeltProfile(
      policyFor(root, { writeDenied: [path.join(root, '.mcp.json')], readDenied: [secret] }),
    );
    const referenced = new Set(paramNamesReferenced(profile));
    expect(referenced).toEqual(new Set(Object.keys(params)));
    for (const name of Object.keys(params)) expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  it('names params deterministically', () => {
    const root = fs.realpathSync(tempDir());
    const policy = policyFor(root, { writeDenied: [path.join(root, '.envrc')] });
    expect(buildSeatbeltProfile(policy)).toEqual(buildSeatbeltProfile(policy));
  });

  it('places writeDenied deny rules after the write allows', () => {
    const root = fs.realpathSync(tempDir());
    const { profile, params } = buildSeatbeltProfile(policyFor(root, { writeDenied: [path.join(root, '.git', 'config')] }));
    const deniedName = Object.entries(params).find(([, value]) => value === path.join(root, '.git', 'config'))?.[0];
    const rootName = Object.entries(params).find(([, value]) => value === root)?.[0];
    expect(deniedName).toBeDefined();
    expect(rootName).toBeDefined();
    const allowIndex = profile.search(new RegExp(`\\(allow file-write\\*[^]*?\\(param "${rootName}"\\)`));
    const denyIndex = profile.search(new RegExp(`\\(deny file-write\\*[^]*?\\(param "${deniedName}"\\)`));
    expect(allowIndex).toBeGreaterThanOrEqual(0);
    expect(denyIndex).toBeGreaterThan(allowIndex);
    expect(profile.lastIndexOf('(allow file-write')).toBeLessThan(denyIndex);
  });

  it('allows file reads globally and denies readDenied subpaths after', () => {
    const root = fs.realpathSync(tempDir());
    const secret = path.join(root, 'secret');
    fs.mkdirSync(secret);
    const { profile, params } = buildSeatbeltProfile(policyFor(root, { readDenied: [secret] }));
    const secretName = Object.entries(params).find(([, value]) => value === secret)?.[0];
    expect(secretName).toBeDefined();
    expect(profile).toMatch(/\(allow file-read\*\)/);
    const denyIndex = profile.search(new RegExp(`\\(deny file-read\\*[^]*?\\(subpath \\(param "${secretName}"\\)\\)`));
    expect(denyIndex).toBeGreaterThan(profile.indexOf('(allow file-read*)'));
  });

  it('emits no network rules when network is deny', () => {
    const { profile } = buildSeatbeltProfile(policyFor(tempDir(), { network: 'deny' }));
    expect(profile).not.toMatch(/network/);
  });

  it('allows network when network is allow', () => {
    const { profile } = buildSeatbeltProfile(policyFor(tempDir(), { network: 'allow' }));
    expect(profile).toContain('(allow network*)');
  });

  it('does not allow keychain or securityd mach services', () => {
    const { profile } = buildSeatbeltProfile(policyFor(tempDir()));
    expect(profile).not.toMatch(/com\.apple\.securityd/);
    expect(profile).not.toMatch(/SecurityServer/);
    expect(profile).not.toMatch(/\(allow mach-lookup\)/);
    expect(profile).toMatch(/\(allow process-exec/);
    expect(profile).toMatch(/\(allow process-fork/);
    expect(profile).toMatch(/\(allow sysctl-read/);
  });

  it('canonicalizes symlinked paths with realpath, including not-yet-existing children', () => {
    const real = fs.realpathSync(tempDir());
    const linkParent = tempDir();
    const link = path.join(linkParent, 'link');
    fs.symlinkSync(real, link);
    const secret = path.join(real, 'secret');
    fs.mkdirSync(secret);
    const { params } = buildSeatbeltProfile(
      policyFor(link, { writeDenied: [path.join(link, '.mcp.json')], readDenied: [path.join(link, 'secret')] }),
    );
    const values = Object.values(params);
    expect(values).toContain(real);
    expect(values).toContain(path.join(real, '.mcp.json'));
    expect(values).toContain(secret);
    expect(values.some((value) => value.startsWith(link))).toBe(false);
  });

  it('rejects relative paths, naming them', () => {
    expect(() => buildSeatbeltProfile(policyFor('rel/root-dir'))).toThrow(/rel\/root-dir/);
    const root = tempDir();
    expect(() => buildSeatbeltProfile(policyFor(root, { readDenied: ['rel/secret-dir'] }))).toThrow(/rel\/secret-dir/);
    expect(() => buildSeatbeltProfile(policyFor(root, { writeDenied: ['rel/hook-dir'] }))).toThrow(/rel\/hook-dir/);
  });
});

describe('defaultProtectedPaths', () => {
  it('includes persistence and escape vectors inside the root', () => {
    const root = '/work/project';
    const paths = defaultProtectedPaths(root);
    for (const expected of [
      '/work/project/.git/hooks',
      '/work/project/.git/config',
      '/work/project/.momonga',
      '/work/project/.mcp.json',
      '/work/project/.envrc',
      '/work/project/.vscode',
      '/work/project/.idea',
    ]) {
      expect(paths).toContain(expected);
    }
  });

  it('returns only paths inside the root', () => {
    for (const entry of defaultProtectedPaths('/work/project')) expect(entry.startsWith('/work/project/')).toBe(true);
  });
});
