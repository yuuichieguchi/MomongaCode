import { build } from 'esbuild';
import { constants, brotliCompressSync } from 'node:zlib';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { sha256Hex } from '@momonga/foundation';
import { Z3_API_FILE, Z3_MANIFEST_ASSET, Z3_RUNTIME_FILE, Z3_WASM_ASSET } from '@momonga/verify';
import type { Z3Manifest } from '@momonga/verify';

export const Z3_BROTLI_QUALITY = 9;
export const Z3_BROTLI_WINDOW_BITS = 24;

const WASM_FILE = 'z3-built.wasm';

export const z3BuildDirectory = (from: string): string => path.dirname(createRequire(from).resolve('z3-solver'));

export const buildZ3Assets = async (workDir: string, from: string): Promise<Record<string, string>> => {
  const source = z3BuildDirectory(from);
  const directory = path.join(workDir, 'z3');
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  const api = path.join(directory, Z3_API_FILE);
  await build({ entryPoints: [path.join(source, 'node.js')], outfile: api, bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['./z3-built'], logLevel: 'warning' });
  const runtime = path.join(directory, Z3_RUNTIME_FILE);
  fs.copyFileSync(path.join(source, Z3_RUNTIME_FILE), runtime);
  const wasm = fs.readFileSync(path.join(source, WASM_FILE));
  const compressed = path.join(directory, Z3_WASM_ASSET);
  fs.writeFileSync(
    compressed,
    brotliCompressSync(wasm, { params: { [constants.BROTLI_PARAM_QUALITY]: Z3_BROTLI_QUALITY, [constants.BROTLI_PARAM_LGWIN]: Z3_BROTLI_WINDOW_BITS, [constants.BROTLI_PARAM_SIZE_HINT]: wasm.length } }),
  );
  const files = [Z3_API_FILE, Z3_RUNTIME_FILE].map((name) => ({ name, sha256: sha256Hex(fs.readFileSync(path.join(directory, name))) }));
  const wasmSha = sha256Hex(wasm);
  const manifest: Z3Manifest = {
    contentHash: sha256Hex(JSON.stringify({ files, wasm: wasmSha })),
    files,
    wasm: { asset: Z3_WASM_ASSET, sha256: wasmSha },
  };
  const manifestFile = path.join(directory, Z3_MANIFEST_ASSET);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  return {
    [Z3_MANIFEST_ASSET]: manifestFile,
    [Z3_API_FILE]: api,
    [Z3_RUNTIME_FILE]: runtime,
    [Z3_WASM_ASSET]: compressed,
  };
};
