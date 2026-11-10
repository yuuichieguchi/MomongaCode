import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const gatewaySource = path.resolve(import.meta.dirname, '..', 'packages', 'gateway', 'src');

const sourcesOf = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourcesOf(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });

const relative = (file: string): string => path.relative(gatewaySource, file).split(path.sep).join('/');

const SOURCES = sourcesOf(gatewaySource).map((file) => ({ file: relative(file), text: fs.readFileSync(file, 'utf8') }));

const cacheBindings = (): Array<{ file: string; name: string }> =>
  SOURCES.flatMap(({ file, text }) => [...text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*createUserSettingsCache\(/g)].map((match) => ({ file, name: match[1] as string })));

describe('O-R5-6 (K) 5: every read of settings in the gateway process goes through the pinned derivation', () => {
  it('the gateway builds its user settings cache in exactly one place', () => {
    expect(cacheBindings()).toEqual([{ file: 'process.ts', name: 'cache' }]);
  });

  it('nothing in packages/gateway/src calls get() on the user settings cache', () => {
    const calls = cacheBindings().flatMap(({ file, name }) =>
      SOURCES.filter((source) => source.file === file).flatMap(({ text }) =>
        text.split('\n').flatMap((line, index) => (new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\.get\\(`).test(line) ? [`${file}:${index + 1}`] : [])),
      ),
    );
    expect(calls).toEqual([]);
  });

  it('nothing in packages/gateway/src calls read() on the user settings cache', () => {
    const calls = cacheBindings().flatMap(({ file, name }) =>
      SOURCES.filter((source) => source.file === file).flatMap(({ text }) =>
        text.split('\n').flatMap((line, index) => (new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\.read\\(`).test(line) ? [`${file}:${index + 1}`] : [])),
      ),
    );
    expect(calls).toEqual([]);
  });

  it('nothing in packages/gateway/src reads a settings section from a get() result', () => {
    const reads = SOURCES.flatMap(({ file, text }) =>
      text.split('\n').flatMap((line, index) => (/\.get\(\)\.(?:models|network|pricing|context|credentials|telemetry|gateway|sandbox)\b/.test(line) ? [`${file}:${index + 1}`] : [])),
    );
    expect(reads).toEqual([]);
  });
});
