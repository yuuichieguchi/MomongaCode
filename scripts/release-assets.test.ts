import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RELEASE_ASSETS } from '@momonga/foundation';
import { repoRoot } from './bundle.ts';
import { SEA_TARGETS } from './node-runtime.ts';

const read = (file: string): string => fs.readFileSync(`${repoRoot}${file}`, 'utf8');

const bashArray = (source: string, name: string): string[] => {
  const match = new RegExp(`readonly ${name}=\\(([^)]*)\\)`).exec(source);
  if (match === null) throw new Error(`${name} is not declared`);
  return (match[1] as string).trim().split(/\s+/);
};

describe('the table of release assets', () => {
  const names = Object.entries(RELEASE_ASSETS);

  it('names the same assets as the single-executable targets', () => {
    expect(Object.keys(SEA_TARGETS).sort()).toEqual(Object.keys(RELEASE_ASSETS).sort());
    for (const [target, asset] of names) expect(SEA_TARGETS[target as keyof typeof SEA_TARGETS].assetName).toBe(asset);
  });

  it('is the set of assets release.sh builds and publishes', () => {
    const script = read('scripts/release.sh');
    const darwin = /readonly ASSET_NAME="([^"]+)"/.exec(script)?.[1];
    const others = bashArray(script, 'OTHER_ASSETS');
    const targets = bashArray(script, 'OTHER_TARGETS');
    expect([darwin, ...others].sort()).toEqual(Object.values(RELEASE_ASSETS).sort());
    expect(['darwin-arm64', ...targets].map((target) => RELEASE_ASSETS[target as keyof typeof RELEASE_ASSETS])).toEqual([darwin, ...others]);
  });

  it('is the set of assets install.sh and install.ps1 choose from', () => {
    const shell = read('scripts/install.sh');
    const chosen = [...shell.matchAll(/ASSET_NAME="([^"]+)"/g)].map((match) => match[1] as string);
    const powershell = /\$assetName = '([^']+)'/.exec(read('scripts/install.ps1'))?.[1];
    expect([...chosen, powershell].sort()).toEqual(Object.values(RELEASE_ASSETS).sort());
  });
});
