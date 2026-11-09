import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Z3_API_FILE, Z3_EXTRACTED_FILES, Z3_MANIFEST_ASSET, Z3_RUNTIME_FILE, Z3_WASM_ASSET, ensureBundledZ3, openZ3, parseZ3Manifest } from '@momonga/verify';
import { Z3_BROTLI_QUALITY, buildZ3Assets } from './z3-assets.ts';
import { UNBOUNDED_BUILD_WAIT_MS } from './support/build-wait.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';

describe('the Z3 assets embedded in the single executable', () => {
  let root = '';
  let assets: Record<string, string> = {};

  beforeAll(async () => {
    root = fs.realpathSync(createTempRoot());
    assets = await buildZ3Assets(path.join(root, 'work'), import.meta.url);
  }, UNBOUNDED_BUILD_WAIT_MS);

  afterAll(() => {
    removeTempRoot(root);
  });

  it('names exactly the manifest, the two extracted files and the compressed solver binary', () => {
    expect(Object.keys(assets).sort()).toEqual([Z3_MANIFEST_ASSET, Z3_API_FILE, Z3_RUNTIME_FILE, Z3_WASM_ASSET].sort());
    expect(parseZ3Manifest(fs.readFileSync(assets[Z3_MANIFEST_ASSET] as string, 'utf8')).files.map((file) => file.name)).toEqual([...Z3_EXTRACTED_FILES]);
    expect(Z3_BROTLI_QUALITY).toBe(9);
  });

  it('extracts into a cache folder from which the bundled API starts the solver on worker threads and decides a query', async () => {
    const cacheBase = path.join(root, 'cache');
    const read = (name: string): Uint8Array => fs.readFileSync(assets[name] as string);
    const bundled = await ensureBundledZ3({
      asset: read,
      cacheBase,
      random: () => 0.5,
      files: {
        exists: async (target) => fs.existsSync(target),
        mkdir: async (directory) => void fs.mkdirSync(directory, { recursive: true }),
        writeBytes: async (file, bytes) => fs.writeFileSync(file, bytes),
        readFile: async (file) => fs.readFileSync(file),
        rename: async (from, to) => fs.renameSync(from, to),
        rm: async (directory) => fs.rmSync(directory, { recursive: true, force: true }),
      },
    });

    expect(fs.readdirSync(path.dirname(bundled.entry)).sort()).toEqual([Z3_API_FILE, Z3_RUNTIME_FILE].sort());
    const engine = await openZ3(bundled);
    try {
      const ctx = new engine.api.Context('main');
      const solver = new ctx.Solver();
      const value = ctx.String.const('value');
      solver.add(ctx.InRe(value, ctx.Re.toRe('ab').plus()), value.length().gt(5));
      expect(await solver.check()).toBe('sat');
    } finally {
      await engine.close();
    }
  }, 120_000);
});
