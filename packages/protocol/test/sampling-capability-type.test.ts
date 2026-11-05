import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

const protocolSources = fs
  .readdirSync(sourceDir)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => ({ name, text: fs.readFileSync(path.join(sourceDir, name), 'utf8') }));

describe('sampling acceptance has one capability type', () => {
  it.for(['SamplingDeclaration', 'DeclaredSamplingCapabilities'])('no protocol source defines or exports %s', (parallelType) => {
    expect(protocolSources.filter(({ text }) => new RegExp(`\\b${parallelType}\\b`).test(text)).map(({ name }) => name)).toEqual([]);
  });

  it('CapabilitiesCore carries sampling', () => {
    const capabilities = protocolSources.find(({ name }) => name === 'capabilities.ts')?.text ?? '';
    const core = /export type CapabilitiesCore = \{([\s\S]*?)\n\};/.exec(capabilities)?.[1] ?? '';
    expect(core).toMatch(/\bsampling\?: SamplingCapability;/);
  });
});
