import fs from 'node:fs';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SYSTEM_RESOLVER_SOCKET, buildSeatbeltProfile } from '@momonga/sandbox';
import type { SandboxPolicy } from '@momonga/sandbox';
import { makeTempDir } from './helpers.ts';
import { NEVER_CANCELLED, testPaths } from '@momonga/testkit';

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
  return { writableRoots: [root], writeDenied: [], protectedSet: EMPTY_PROTECTED_SET, writeDeniedLiterals: [], fileRules: EMPTY_FILE_RULES, readDenied: [], network: 'deny', ...overrides };
}

function paramNamesReferenced(profile: string): string[] {
  return [...profile.matchAll(/\(param "([^"]+)"\)/g)].map((match) => match[1] ?? '');
}

describe('buildSeatbeltProfile', () => {
  it('starts with version 1 and deny default', async () => {
    const { profile } = await buildSeatbeltProfile(policyFor(tempDir()), {}, testPaths());
    expect(profile).toMatch(/^\(version 1\)/);
    expect(profile).toContain('(deny default)');
  });

  it('never interpolates paths into the profile text', async () => {
    const base = tempDir();
    const root = fs.realpathSync(base);
    const secret = path.join(root, 'secret');
    fs.mkdirSync(secret);
    const { profile, params } = await buildSeatbeltProfile(
      policyFor(root, { writeDenied: [path.join(root, '.git', 'hooks')], readDenied: [secret] }), {}, testPaths());
    expect(profile).not.toContain(root);
    expect(profile).not.toContain(path.basename(base));
    expect(Object.values(params)).toContain(root);
    expect(Object.values(params)).toContain(secret);
    expect(Object.values(params)).toContain(path.join(root, '.git', 'hooks'));
  });

  it('keeps hostile characters out of the profile and passes them verbatim as params', async () => {
    const parent = fs.realpathSync(tempDir());
    const root = path.join(parent, 'a"b)c;d\n(allow default)-日本');
    fs.mkdirSync(root);
    const { profile, params } = await buildSeatbeltProfile(policyFor(root), {}, testPaths());
    expect(profile).not.toContain('日本');
    expect(profile).not.toContain('a"b');
    expect(profile.match(/\(allow default\)/g)).toBeNull();
    expect(Object.values(params)).toContain(root);
  });

  it('references every param it defines and defines every param it references', async () => {
    const root = fs.realpathSync(tempDir());
    const secret = path.join(root, 'secret');
    fs.mkdirSync(secret);
    const { profile, params } = await buildSeatbeltProfile(
      policyFor(root, { writeDenied: [path.join(root, '.mcp.json')], readDenied: [secret] }), {}, testPaths());
    const referenced = new Set(paramNamesReferenced(profile));
    expect(referenced).toEqual(new Set(Object.keys(params)));
    for (const name of Object.keys(params)) expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  it('names params deterministically', async () => {
    const root = fs.realpathSync(tempDir());
    const policy = policyFor(root, { writeDenied: [path.join(root, '.envrc')] });
    expect(await buildSeatbeltProfile(policy, {}, testPaths())).toEqual(await buildSeatbeltProfile(policy, {}, testPaths()));
  });

  it('places writeDenied deny rules after the write allows', async () => {
    const root = fs.realpathSync(tempDir());
    const { profile, params } = await buildSeatbeltProfile(policyFor(root, { writeDenied: [path.join(root, '.git', 'config')] }), {}, testPaths());
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

  it('allows file reads globally and denies readDenied subpaths after', async () => {
    const root = fs.realpathSync(tempDir());
    const secret = path.join(root, 'secret');
    fs.mkdirSync(secret);
    const { profile, params } = await buildSeatbeltProfile(policyFor(root, { readDenied: [secret] }), {}, testPaths());
    const secretName = Object.entries(params).find(([, value]) => value === secret)?.[0];
    expect(secretName).toBeDefined();
    expect(profile).toMatch(/\(allow file-read\*\)/);
    const denyIndex = profile.search(new RegExp(`\\(deny file-read\\*[^]*?\\(subpath \\(param "${secretName}"\\)\\)`));
    expect(denyIndex).toBeGreaterThan(profile.indexOf('(allow file-read*)'));
  });

  it('emits no network rules when network is deny', async () => {
    const { profile } = await buildSeatbeltProfile(policyFor(tempDir(), { network: 'deny' }), {}, testPaths());
    expect(profile).not.toMatch(/network/);
  });

  it('allows IP outbound and the system resolver socket when network is allow, never every network operation', async () => {
    const { profile } = await buildSeatbeltProfile(policyFor(tempDir(), { network: 'allow' }), {}, testPaths());
    expect(profile).toContain('(allow network-outbound (remote ip))');
    expect(profile).toContain(`(allow network-outbound (remote unix-socket (path-literal "${SYSTEM_RESOLVER_SOCKET}")))`);
    expect(profile).not.toContain('(allow network*)');
  });

  it('does not allow keychain or securityd mach services', async () => {
    const { profile } = await buildSeatbeltProfile(policyFor(tempDir()), {}, testPaths());
    expect(profile).not.toMatch(/com\.apple\.securityd/);
    expect(profile).not.toMatch(/SecurityServer/);
    expect(profile).not.toMatch(/\(allow mach-lookup\)/);
    expect(profile).toMatch(/\(allow process-exec/);
    expect(profile).toMatch(/\(allow process-fork/);
    expect(profile).toMatch(/\(allow sysctl-read/);
  });

  it('allows only the named lookup services, the scheduling of the process itself and the one materialization flag that read-only programs need', async () => {
    const { profile } = await buildSeatbeltProfile(policyFor(tempDir()), {}, testPaths());
    const lookups = [...profile.matchAll(/^\(allow mach-lookup (.*)\)$/gm)].map((match) => match[1]);
    expect(lookups).toEqual(['(global-name "com.apple.bsd.dirhelper") (global-name "com.apple.system.opendirectoryd.libinfo")']);
    expect(profile).toContain('(allow system-sched (target self))');
    expect(profile).toContain('(allow sysctl-write (sysctl-name "vfs.nspace.prevent_materialization"))');
    expect(profile.match(/\(allow sysctl-write/g)).toHaveLength(1);
  });

  it('canonicalizes symlinked paths with realpath, including not-yet-existing children', async () => {
    const real = fs.realpathSync(tempDir());
    const linkParent = tempDir();
    const link = path.join(linkParent, 'link');
    fs.symlinkSync(real, link);
    const secret = path.join(real, 'secret');
    fs.mkdirSync(secret);
    const { params } = await buildSeatbeltProfile(
      policyFor(link, { writeDenied: [path.join(link, '.mcp.json')], readDenied: [path.join(link, 'secret')] }), {}, testPaths());
    const values = Object.values(params);
    expect(values).toContain(real);
    expect(values).toContain(path.join(real, '.mcp.json'));
    expect(values).toContain(secret);
    expect(values.some((value) => value.startsWith(link))).toBe(false);
  });

  it('rejects relative paths, naming them', async () => {
    await expect(buildSeatbeltProfile(policyFor('rel/root-dir'), {}, testPaths())).rejects.toThrow(/rel\/root-dir/);
    const root = tempDir();
    await expect(buildSeatbeltProfile(policyFor(root, { readDenied: ['rel/secret-dir'] }), {}, testPaths())).rejects.toThrow(/rel\/secret-dir/);
    await expect(buildSeatbeltProfile(policyFor(root, { writeDenied: ['rel/hook-dir'] }), {}, testPaths())).rejects.toThrow(/rel\/hook-dir/);
  });
});
