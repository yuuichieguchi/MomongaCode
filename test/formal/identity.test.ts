import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRoot, removeTempRoot } from '../../scripts/support/temp.ts';
import { cfgFor, holdsEntry, tinySpec, writeFile } from './fixtures.ts';
import { keyOf, keyPartsOf, specIdentityOf } from './reuse.ts';
import type { JavaIdentity } from './reuse.ts';

const JAVA: JavaIdentity = { runtime: '22.0.1+8-16', vm: 'OpenJDK 64-Bit Server VM', os: 'Mac OS X', arch: 'aarch64' };

describe('the identity of a row and its reuse key', () => {
  let root = '';
  const specFile = (name: string): string => path.join(root, 'specs', 'tla', name);
  const identity = (): Promise<string> => specIdentityOf(root, { config: 'Tiny', args: [] });
  const keyOfRow = async (): Promise<string> => keyOf((await keyPartsOf({ repoRoot: root, entry: holdsEntry, args: ['-fp', '0'], workers: 5, java: JAVA })) as Parameters<typeof keyOf>[0]);

  beforeEach(() => {
    root = createTempRoot();
    writeFile(path.join(root, '.cache', 'tla', 'tla2tools.jar'), 'fake jar bytes');
    writeFile(specFile('Tiny.tla'), tinySpec);
    writeFile(specFile('Tiny.cfg'), cfgFor('Small'));
    writeFile(specFile('Handover.actors.json'), '[]\n');
    writeFile(specFile('manifest.json'), '{}\n');
  });

  afterEach(() => {
    removeTempRoot(root);
  });

  it('does not change when only comments of the module and the cfg change', async () => {
    const before = await identity();
    writeFile(specFile('Tiny.tla'), `(* header (* nested *) note *)\n${tinySpec.replace('Small == x <= 2', 'Small == x <= 2 \\* the bound')}\n\\* trailing note\n`);
    writeFile(specFile('Tiny.cfg'), `\\* a comment\n${cfgFor('Small')}\n(* block *)\n`);
    expect(await identity()).toBe(before);
  });

  it('does not change when only the comments of a module it extends change', async () => {
    writeFile(specFile('Naturals.tla'), '---- MODULE Naturals ----\n====\n');
    const before = await identity();
    writeFile(specFile('Naturals.tla'), '---- MODULE Naturals ----\n\\* added note\n(* and a block *)\n====\n');
    expect(await identity()).toBe(before);
  });

  it('changes when a token of the module changes', async () => {
    const before = await identity();
    writeFile(specFile('Tiny.tla'), tinySpec.replace('x <= 2', 'x <= 3'));
    expect(await identity()).not.toBe(before);
  });

  it('changes when the cfg changes its configuration', async () => {
    const before = await identity();
    writeFile(specFile('Tiny.cfg'), cfgFor('Other'));
    expect(await identity()).not.toBe(before);
  });

  it('changes when a JSON input of the specification changes', async () => {
    const before = await identity();
    writeFile(specFile('Handover.actors.json'), '[1]\n');
    expect(await identity()).not.toBe(before);
  });

  it('keeps the reuse key on the raw bytes, so a comment changes the key', async () => {
    const before = await keyOfRow();
    writeFile(specFile('Tiny.tla'), `\\* comment\n${tinySpec}`);
    expect(await keyOfRow()).not.toBe(before);
  });
});
