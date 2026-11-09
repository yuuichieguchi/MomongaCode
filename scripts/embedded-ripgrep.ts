import fs from 'node:fs';
import { RIPGREP_BINARY_ASSET, parseRipgrepManifest } from '@momonga/tools';
import type { RipgrepManifest } from '@momonga/tools';
import { RIPGREP_VERSION } from './ripgrep-release.ts';

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MANIFEST_START = new RegExp(`\\{"version":"[^"\\x00-\\x1f]*","target":"[^"\\x00-\\x1f]*","binary":\\{"asset":"${escapeRegExp(RIPGREP_BINARY_ASSET)}"`, 'g');

const balancedObjectAt = (text: string, start: number): string => {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  throw new Error(`the ripgrep manifest that starts at byte ${start} is not closed`);
};

export const embeddedRipgrepManifests = (bytes: Buffer): RipgrepManifest[] => {
  const text = bytes.toString('latin1');
  return [...text.matchAll(MANIFEST_START)].map((match) => parseRipgrepManifest(balancedObjectAt(text, match.index)));
};

export const assertEmbeddedRipgrep = (file: string, target: string): void => {
  const manifests = embeddedRipgrepManifests(fs.readFileSync(file));
  if (manifests.length === 0) throw new Error(`${file} embeds no ripgrep manifest`);
  if (manifests.length > 1) throw new Error(`${file} embeds ${manifests.length} ripgrep manifests`);
  const [manifest] = manifests as [RipgrepManifest];
  if (manifest.target !== target) throw new Error(`${file} embeds the ripgrep manifest of ${manifest.target}, not of ${target}`);
  if (manifest.version !== RIPGREP_VERSION) throw new Error(`${file} embeds ripgrep ${manifest.version}, not the pinned ${RIPGREP_VERSION}`);
};

if (import.meta.main) {
  const [command, file, target] = process.argv.slice(2);
  try {
    if (command !== 'check' || file === undefined || target === undefined) throw new Error('usage: embedded-ripgrep.ts check <executable> <release target>');
    assertEmbeddedRipgrep(file, target);
  } catch (error) {
    process.stderr.write(`embedded-ripgrep.ts: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
