import path from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@momonga/foundation';
import { Z3DistributionError, Z3_API_FILE, Z3_MANIFEST_ASSET, Z3_RUNTIME_FILE, Z3_WASM_ASSET, ensureBundledZ3, parseZ3Manifest } from '../src/index.ts';
import type { DistributionFiles, DistributionPorts } from '../src/index.ts';

const API = new TextEncoder().encode('module.exports = { api: true };');
const RUNTIME = new TextEncoder().encode('module.exports = { runtime: true };');
const WASM = new Uint8Array(4096).map((_, index) => index % 251);
const CACHE = '/cache/momonga';

const manifestFor = (api: Uint8Array = API) => {
  const files = [
    { name: Z3_API_FILE, sha256: sha256Hex(api) },
    { name: Z3_RUNTIME_FILE, sha256: sha256Hex(RUNTIME) },
  ];
  const wasm = { asset: Z3_WASM_ASSET, sha256: sha256Hex(WASM) };
  return { contentHash: sha256Hex(JSON.stringify({ files, wasm: wasm.sha256 })), files, wasm };
};

type Memory = { files: Map<string, Uint8Array>; directories: Set<string>; renames: number; failRename?: () => Promise<void> };

const memoryFiles = (memory: Memory): DistributionFiles => ({
  exists: async (target) => memory.files.has(target) || memory.directories.has(target),
  ensureDirectory: async (directory) => void memory.directories.add(directory),
  writeBytes: async (file, bytes) => void memory.files.set(file, bytes),
  readBytes: async (file) => {
    const bytes = memory.files.get(file);
    if (bytes === undefined) throw new Error(`no such file ${file}`);
    return bytes;
  },
  rename: async (from, to) => {
    memory.renames += 1;
    await memory.failRename?.();
    for (const [file, bytes] of [...memory.files]) {
      if (file.startsWith(`${from}/`)) {
        memory.files.delete(file);
        memory.files.set(file.replace(from, to), bytes);
      }
    }
    memory.directories.delete(from);
    memory.directories.add(to);
  },
  removeTree: async (directory) => {
    for (const file of [...memory.files.keys()]) if (file.startsWith(`${directory}/`)) memory.files.delete(file);
    memory.directories.delete(directory);
  },
});

const portsFor = (memory: Memory, assets: Record<string, Uint8Array>): DistributionPorts => ({
  asset: (name) => {
    const bytes = assets[name];
    if (bytes === undefined) throw new Error(`no asset ${name}`);
    return bytes;
  },
  files: memoryFiles(memory),
  executablesRoot: CACHE,
  random: () => 0.25,
});

const assetsFor = (manifest: object = manifestFor(), api: Uint8Array = API): Record<string, Uint8Array> => ({
  [Z3_MANIFEST_ASSET]: new TextEncoder().encode(JSON.stringify(manifest)),
  [Z3_API_FILE]: api,
  [Z3_RUNTIME_FILE]: RUNTIME,
  [Z3_WASM_ASSET]: brotliCompressSync(WASM),
});

const emptyMemory = (): Memory => ({ files: new Map(), directories: new Set(), renames: 0 });

describe('the embedded Z3 distribution', () => {
  it('is extracted once into a folder named by its content hash, and the solver binary stays in memory', async () => {
    const memory = emptyMemory();

    const first = await ensureBundledZ3(portsFor(memory, assetsFor()));

    const directory = path.join(CACHE, `z3-${manifestFor().contentHash.slice(0, 16)}`);
    expect(first.entry).toBe(path.join(directory, Z3_API_FILE));
    expect(Buffer.from(first.wasmBinary).equals(Buffer.from(WASM))).toBe(true);
    expect([...memory.files.keys()].sort()).toEqual([path.join(directory, Z3_API_FILE), path.join(directory, Z3_RUNTIME_FILE)]);
    expect(memory.renames).toBe(1);

    const second = await ensureBundledZ3(portsFor(memory, assetsFor()));
    expect(second.entry).toBe(first.entry);
    expect(memory.renames).toBe(1);
  });

  it('refuses an extracted file that no longer matches the embedded checksum and says how to repair it', async () => {
    const memory = emptyMemory();
    const { entry } = await ensureBundledZ3(portsFor(memory, assetsFor()));
    memory.files.set(entry, new TextEncoder().encode('tampered'));

    await expect(ensureBundledZ3(portsFor(memory, assetsFor()))).rejects.toThrow(/does not match the embedded Z3 distribution; delete .* so that it is extracted again/);
  });

  it('refuses an embedded asset whose bytes differ from its manifest, before anything is written to the final folder', async () => {
    const memory = emptyMemory();
    const wrong = new TextEncoder().encode('module.exports = { api: false };');

    await expect(ensureBundledZ3(portsFor(memory, assetsFor(manifestFor(), wrong)))).rejects.toBeInstanceOf(Z3DistributionError);
    expect(memory.files.size).toBe(0);
    expect(memory.directories.size).toBe(0);
  });

  it('accepts the folder a concurrent run extracted first when its own rename loses, and removes its partial folder', async () => {
    const memory = emptyMemory();
    const directory = path.join(CACHE, `z3-${manifestFor().contentHash.slice(0, 16)}`);
    memory.failRename = async () => {
      memory.files.set(path.join(directory, Z3_API_FILE), API);
      memory.files.set(path.join(directory, Z3_RUNTIME_FILE), RUNTIME);
      memory.directories.add(directory);
      throw Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' });
    };

    const bundled = await ensureBundledZ3(portsFor(memory, assetsFor()));

    expect(bundled.entry).toBe(path.join(directory, Z3_API_FILE));
    expect([...memory.directories].filter((entry) => entry.includes('.partial-'))).toEqual([]);
  });

  it('fails when the rename fails and no folder exists afterwards', async () => {
    const memory = emptyMemory();
    memory.failRename = async () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    };

    await expect(ensureBundledZ3(portsFor(memory, assetsFor()))).rejects.toThrow('permission denied');
  });

  it('rejects a malformed manifest naming the field', () => {
    expect(() => parseZ3Manifest('{}')).toThrow(Z3DistributionError);
    expect(() => parseZ3Manifest(JSON.stringify({ ...manifestFor(), contentHash: 'abc' }))).toThrow('content hash');
    expect(() => parseZ3Manifest(JSON.stringify({ ...manifestFor(), wasm: { asset: 1 } }))).toThrow('solver binary');
  });
});
