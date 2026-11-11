import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { containsByComponents } from '@momonga/foundation';
import { nestedInstructionCandidates } from '@momonga/context';
import type { InstructionReader } from '@momonga/context';
import { discoverInstructions } from '../src/instructions.ts';

const ROOT = 'C:\\work\\app';
const HOME = 'C:\\Users\\u';

const win32Reader = (files: Readonly<Record<string, string>>): InstructionReader => ({
  platform: 'win32',
  contains: async (directory, candidate) => containsByComponents({ existing: directory, tail: [] }, { existing: candidate, tail: [] }, true, path.win32),
  read: async (filePath) => (files[filePath] === undefined ? undefined : { realPath: filePath, text: files[filePath] }),
  exists: async (filePath) => files[filePath] !== undefined,
  realpath: async (filePath) => filePath,
});

describe('instruction files on a Windows host', () => {
  it('names the nested AGENTS.md files above a touched file given in Windows form', () => {
    expect(nestedInstructionCandidates([ROOT], ROOT, [{ path: 'C:\\work\\app\\src\\ui\\a.ts', kind: 'file' }], 'win32')).toEqual([
      'C:\\work\\app\\src\\AGENTS.md',
      'C:\\work\\app\\src\\ui\\AGENTS.md',
    ]);
  });

  it('names no file for a path beside the project that shares its prefix', () => {
    expect(nestedInstructionCandidates([ROOT], ROOT, [{ path: 'C:\\work\\application\\src\\a.ts', kind: 'file' }], 'win32')).toEqual([]);
  });

  it('loads the user, root and nested files by their Windows paths', async () => {
    const discovered = await discoverInstructions({
      reader: win32Reader({
        'C:\\Users\\u\\.momonga\\AGENTS.md': 'user rules',
        'C:\\work\\app\\AGENTS.md': 'root rules',
        'C:\\work\\app\\src\\AGENTS.md': 'nested rules',
      }),
      home: HOME,
      projectRoot: `${ROOT}\\`,
      trusted: true,
      touchedPaths: [{ path: 'C:\\work\\app\\src\\a.ts', kind: 'file' }],
    });
    expect(discovered.user?.instruction.text).toBe('user rules');
    expect(discovered.root?.instruction.text).toBe('root rules');
    expect(discovered.nested.map((file) => file.instruction.path)).toEqual(['C:\\work\\app\\src\\AGENTS.md']);
    expect(discovered.nested[0]?.message.content).toContain('(applies to C:\\work\\app\\src\\**)');
  });
});
