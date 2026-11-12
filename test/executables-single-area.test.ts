import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import os from 'node:os';
import { momongaLayout, nodeFileSystem, sha256Hex } from '@momonga/foundation';
import { testKernelLock } from '@momonga/testkit';
import { ensureBundledZ3 } from '@momonga/verify';
import { brotliCompressSync } from 'node:zlib';

const root = path.resolve(import.meta.dirname, '..');

describe('every executable the product extracts lives under <cacheBase>/executables', () => {
  it.each([
    { platform: 'darwin', home: '/Users/user', flavor: path.posix },
    { platform: 'linux', home: '/home/user', flavor: path.posix },
    { platform: 'win32', home: 'C:\\Users\\user', flavor: path.win32 },
  ] as const)('names the area once in the $platform layout, directly under the cache base', ({ platform, home, flavor }) => {
    const layout = momongaLayout(home, platform, {});
    expect(layout.executables).toBe(flavor.join(layout.cacheBase, 'executables'));
  });

  it('extracts Z3 into <executables>/z3-<hash>, through the executablesRoot port that ripgrep uses too', async () => {
    const wasm = new TextEncoder().encode('wasm');
    const api = new TextEncoder().encode('api');
    const runtime = new TextEncoder().encode('runtime');
    const files = [
      { name: 'z3-api.cjs', sha256: sha256Hex(api) },
      { name: 'z3-built.js', sha256: sha256Hex(runtime) },
    ];
    const manifest = { contentHash: sha256Hex(JSON.stringify({ files, wasm: sha256Hex(wasm) })), files, wasm: { asset: 'z3-built.wasm.br', sha256: sha256Hex(wasm) } };
    const assets: Record<string, Uint8Array> = {
      'z3-manifest.json': new TextEncoder().encode(JSON.stringify(manifest)),
      'z3-api.cjs': api,
      'z3-built.js': runtime,
      'z3-built.wasm.br': brotliCompressSync(wasm),
    };
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-single-area-')));
    const area = momongaLayout(home, 'linux', {}).executables;
    const result = await ensureBundledZ3({
      asset: (name) => assets[name] as Uint8Array,
      executablesRoot: area,
      random: () => 0.5,
      files: nodeFileSystem,
      lock: testKernelLock(),
    });
    fs.rmSync(home, { recursive: true, force: true });
    expect(path.dirname(path.dirname(result.entry))).toBe(area);
    expect(path.basename(path.dirname(result.entry))).toMatch(/^z3-[0-9a-f]{16}$/);
  });

  it('wires the CLI host to the area, not to the whole cache base', () => {
    const host = fs.readFileSync(path.join(root, 'packages', 'cli', 'src', 'verify', 'host.ts'), 'utf8');
    expect(host).toContain('paths.executables');
    expect(host).not.toMatch(/cacheBase:\s*paths\.cacheBase/);
  });

  it('wires the ripgrep host to the same area', () => {
    const sources = fs.readdirSync(path.join(root, 'packages', 'cli', 'src'), { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.ts'));
    const users = sources.filter((name) => fs.readFileSync(path.join(root, 'packages', 'cli', 'src', name), 'utf8').includes('ensureBundledRipgrep'));
    expect(users.length).toBeGreaterThan(0);
    for (const name of users) expect(fs.readFileSync(path.join(root, 'packages', 'cli', 'src', name), 'utf8')).toContain('paths.executables');
  });
});
