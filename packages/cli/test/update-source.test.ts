import { describe, expect, it } from 'vitest';
import { UpdateError } from '../src/update/errors.ts';
import { GITHUB_ENDPOINTS, assetNameFor, resolveUpdateSource } from '../src/update/source.ts';
import { compareVersions, parseReleaseTag, parseVersion } from '../src/update/version.ts';
import { PUBLIC_KEY } from './update-harness.ts';

describe('parseVersion and parseReleaseTag', () => {
  it('reads MAJOR.MINOR.PATCH and a v-prefixed tag', () => {
    expect(parseVersion('1.22.333', 'x')).toEqual({ major: 1, minor: 22, patch: 333, text: '1.22.333' });
    expect(parseReleaseTag('v0.0.1').text).toBe('0.0.1');
  });

  it.each(['1.2', '1.2.3-rc.1', 'v1.2.3', '01.2.3x', '', '1.2.3.4', '1.-2.3', '1234567890.0.0'])('rejects %j', (text) => {
    expect(() => parseVersion(text, 'the running version')).toThrow(UpdateError);
  });

  it('rejects a tag without the v prefix', () => {
    expect(() => parseReleaseTag('1.2.3')).toThrow('does not start with "v"');
  });
});

describe('compareVersions', () => {
  it.each([
    ['1.0.0', '1.0.0', 0],
    ['1.0.1', '1.0.0', 1],
    ['1.0.0', '1.0.1', -1],
    ['1.10.0', '1.9.9', 1],
    ['2.0.0', '1.99.99', 1],
    ['0.9.0', '1.0.0', -1],
  ] as const)('%s against %s is %d', (left, right, expected) => {
    expect(compareVersions(parseVersion(left, 'l'), parseVersion(right, 'r'))).toBe(expected);
  });
});

describe('resolveUpdateSource', () => {
  it('uses a team on macOS and none elsewhere', () => {
    expect(resolveUpdateSource({ repo: 'a/b', teamId: 'ABCDE12345', publicKey: PUBLIC_KEY }, GITHUB_ENDPOINTS, 'darwin').codesign).toEqual({ kind: 'apple-team', teamId: 'ABCDE12345' });
    expect(resolveUpdateSource({ repo: 'a/b', teamId: 'ABCDE12345', publicKey: PUBLIC_KEY }, GITHUB_ENDPOINTS, 'linux').codesign).toEqual({ kind: 'none' });
  });

  it('carries the pinned release key on every platform', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(resolveUpdateSource({ repo: 'a/b', teamId: 'ABCDE12345', publicKey: PUBLIC_KEY }, GITHUB_ENDPOINTS, platform).publicKey).toBe(PUBLIC_KEY);
    }
  });

  it('points at GitHub by default', () => {
    expect(GITHUB_ENDPOINTS).toEqual({ apiBaseUrl: 'https://api.github.com', downloadBaseUrl: 'https://github.com' });
  });
});

describe('assetNameFor', () => {
  it.each([
    ['darwin', 'arm64', 'momonga-darwin-arm64'],
    ['linux', 'x64', 'momonga-linux-x64'],
    ['linux', 'arm64', 'momonga-linux-arm64'],
    ['win32', 'x64', 'momonga-win-x64.exe'],
  ] as const)('%s/%s downloads %s', (platform, arch, asset) => {
    expect(assetNameFor(platform, arch)).toBe(asset);
  });

  it.each([
    ['darwin', 'x64'],
    ['win32', 'arm64'],
    ['freebsd', 'x64'],
  ] as const)('%s/%s has none', (platform, arch) => {
    expect(() => assetNameFor(platform, arch)).toThrow(UpdateError);
  });
});
