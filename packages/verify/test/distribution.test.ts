import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeFileSystem, sha256Hex } from '@momonga/foundation';
import type { HeldKernelLock } from '@momonga/foundation';
import { testKernelLock } from '@momonga/testkit';
import { Z3DistributionError, Z3_API_FILE, Z3_MANIFEST_ASSET, Z3_RUNTIME_FILE, Z3_STAGED_PREFIX, Z3_WASM_ASSET, ensureBundledZ3, parseZ3Manifest } from '../src/index.ts';
import type { DistributionPorts } from '../src/index.ts';

const API = new TextEncoder().encode('module.exports = { api: true };');
const RUNTIME = new TextEncoder().encode('module.exports = { runtime: true };');
const WASM = new Uint8Array(4096).map((_, index) => index % 251);

const manifestFor = (api: Uint8Array = API) => {
  const files = [
    { name: Z3_API_FILE, sha256: sha256Hex(api) },
    { name: Z3_RUNTIME_FILE, sha256: sha256Hex(RUNTIME) },
  ];
  const wasm = { asset: Z3_WASM_ASSET, sha256: sha256Hex(WASM) };
  return { contentHash: sha256Hex(JSON.stringify({ files, wasm: wasm.sha256 })), files, wasm };
};

const assetsFor = (manifest: object = manifestFor(), api: Uint8Array = API): Record<string, Uint8Array> => ({
  [Z3_MANIFEST_ASSET]: new TextEncoder().encode(JSON.stringify(manifest)),
  [Z3_API_FILE]: api,
  [Z3_RUNTIME_FILE]: RUNTIME,
  [Z3_WASM_ASSET]: brotliCompressSync(WASM),
});

const created: string[] = [];
const held: HeldKernelLock[] = [];

afterEach(() => {
  for (const lock of held.splice(0)) lock.release();
  for (const directory of created.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const executablesRoot = (): string => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-z3-distribution-')));
  created.push(root);
  return root;
};

const portsFor = (root: string, assets: Record<string, Uint8Array> = assetsFor()): DistributionPorts => {
  let counter = 0;
  return {
    asset: (name) => {
      const bytes = assets[name];
      if (bytes === undefined) throw new Error(`no asset ${name}`);
      return bytes;
    },
    files: nodeFileSystem,
    executablesRoot: root,
    random: () => {
      counter += 1;
      return counter / 1000;
    },
    lock: testKernelLock(),
  };
};

const folderOf = (root: string): string => path.join(root, `z3-${manifestFor().contentHash.slice(0, 16)}`);

describe('the embedded Z3 distribution', () => {
  it('is extracted once into a folder named by its content hash, and the solver binary stays in memory', async () => {
    const root = executablesRoot();
    const first = await ensureBundledZ3(portsFor(root));
    const directory = folderOf(root);
    expect(first.entry).toBe(path.join(directory, Z3_API_FILE));
    expect(Buffer.from(first.wasmBinary).equals(Buffer.from(WASM))).toBe(true);
    expect(fs.readdirSync(directory).sort()).toEqual([Z3_API_FILE, Z3_RUNTIME_FILE].sort());
    const identity = fs.statSync(first.entry).ino;
    const second = await ensureBundledZ3(portsFor(root));
    expect(second.entry).toBe(first.entry);
    expect(fs.statSync(second.entry).ino).toBe(identity);
  });

  it('extracts again an extracted file that no longer matches the embedded checksum, instead of refusing it', async () => {
    const root = executablesRoot();
    const { entry } = await ensureBundledZ3(portsFor(root));
    fs.writeFileSync(entry, 'tampered');
    const repaired = await ensureBundledZ3(portsFor(root));
    expect(Buffer.from(fs.readFileSync(repaired.entry)).equals(Buffer.from(API))).toBe(true);
  });

  it('sweeps a staged file that a run which ended left behind, at the next extraction', async () => {
    const root = executablesRoot();
    const directory = folderOf(root);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const leftover = path.join(directory, `${Z3_STAGED_PREFIX}dead-1-${Z3_API_FILE}`);
    fs.writeFileSync(leftover, 'half written');
    await ensureBundledZ3(portsFor(root));
    expect(fs.existsSync(leftover)).toBe(false);
    expect(fs.readdirSync(directory).filter((name) => name.startsWith(Z3_STAGED_PREFIX))).toEqual([]);
  });

  it('keeps a staged file whose writer still holds it', async () => {
    const root = executablesRoot();
    const directory = folderOf(root);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const writing = path.join(directory, `${Z3_STAGED_PREFIX}live-1-${Z3_API_FILE}`);
    const outcome = await testKernelLock().claim(writing);
    if (outcome.kind !== 'claimed') throw new Error('the test could not hold the staged file');
    held.push(outcome.lock);
    fs.writeFileSync(writing, 'being written');
    await ensureBundledZ3(portsFor(root));
    expect(fs.existsSync(writing)).toBe(true);
  });

  it('refuses an embedded asset whose bytes differ from its manifest, before anything is placed in the folder', async () => {
    const root = executablesRoot();
    const wrong = new TextEncoder().encode('module.exports = { api: false };');
    await expect(ensureBundledZ3(portsFor(root, assetsFor(manifestFor(), wrong)))).rejects.toBeInstanceOf(Z3DistributionError);
    expect(fs.existsSync(path.join(folderOf(root), Z3_API_FILE))).toBe(false);
  });

  it('rejects a malformed manifest naming the field', () => {
    expect(() => parseZ3Manifest('{}')).toThrow(Z3DistributionError);
    expect(() => parseZ3Manifest(JSON.stringify({ ...manifestFor(), contentHash: 'abc' }))).toThrow('content hash');
    expect(() => parseZ3Manifest(JSON.stringify({ ...manifestFor(), wasm: { asset: 1 } }))).toThrow('solver binary');
  });
});
