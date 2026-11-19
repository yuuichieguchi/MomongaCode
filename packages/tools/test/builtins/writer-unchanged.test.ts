import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeFileSystem, systemRandom } from '@momonga/foundation';
import type { FileSystem } from '@momonga/foundation';
import type { WriterLaunch } from '@momonga/tools';
import { writeRequested } from '../../src/builtins/file-writer.ts';
import { makeLayout } from '../helpers.ts';
import { TEST_WRITER_LAUNCH, makeBuiltins, resultOf } from './fixtures.ts';

const ACCEPT_EDITS = { mode: 'acceptEdits' } as const;

const SILENT_LAUNCH: WriterLaunch = { argv: ['/bin/sh', '-c', 'kill -9 $$'] };

const locked: string[] = [];

afterEach(() => {
  for (const folder of locked.splice(0)) fs.chmodSync(folder, 0o755);
});

const lock = (folder: string): string => {
  fs.chmodSync(folder, 0o555);
  locked.push(folder);
  return folder;
};

const scratch = (): string => fs.realpathSync(makeLayout().project);

const failingRename = (files: FileSystem): FileSystem => ({
  ...files,
  rename: async () => {
    throw Object.assign(new Error('the disk refused the rename'), { code: 'EIO' });
  },
});

const failingRemoval = (files: FileSystem): FileSystem => ({
  ...failingRename(files),
  rm: async () => {
    throw Object.assign(new Error('the disk refused the removal'), { code: 'EIO' });
  },
});

const REQUEST = { content: 'x', mode: 0o644, lock: 'file-lock' as const };

describe('the writer reports that a failed write left the workspace unchanged only when it proved it', () => {
  it('a write into a folder without write permission fails before changing anything', async () => {
    const folder = lock(scratch());
    expect(await writeRequested({ files: nodeFileSystem, random: systemRandom }, { ...REQUEST, target: path.join(folder, 'new.txt') })).toMatchObject({ kind: 'failed', workspaceUnchanged: true });
    expect(fs.readdirSync(folder)).toEqual([]);
  });

  it('a write whose temporary file was made and removed again fails before changing anything', async () => {
    const folder = scratch();
    expect(await writeRequested({ files: failingRename(nodeFileSystem), random: systemRandom }, { ...REQUEST, target: path.join(folder, 'new.txt') })).toMatchObject({ kind: 'failed', workspaceUnchanged: true });
    expect(fs.readdirSync(folder)).toEqual([]);
  });

  it('a write that created a missing parent folder and then failed is a change', async () => {
    const folder = scratch();
    const answer = await writeRequested({ files: failingRename(nodeFileSystem), random: systemRandom }, { ...REQUEST, target: path.join(folder, 'made', 'new.txt') });
    expect(answer.kind).toBe('failed');
    expect(answer).not.toHaveProperty('workspaceUnchanged');
    expect(fs.existsSync(path.join(folder, 'made'))).toBe(true);
  });

  it('a write whose temporary file could not be removed is a change', async () => {
    const folder = scratch();
    const answer = await writeRequested({ files: failingRemoval(nodeFileSystem), random: systemRandom }, { ...REQUEST, target: path.join(folder, 'new.txt') });
    expect(answer.kind).toBe('failed');
    expect(answer).not.toHaveProperty('workspaceUnchanged');
  });
});

describe('Write and Edit carry the fact of their writer', () => {
  it('a Write into a folder without write permission fails with the workspace unchanged', async () => {
    const tools = await makeBuiltins({ executor: { writerLaunch: TEST_WRITER_LAUNCH } });
    const folder = lock(path.dirname(tools.write('locked/kept.txt', 'kept\n')));
    const result = resultOf(await tools.run('Write', { file_path: path.join(folder, 'new.txt'), content: 'new\n' }, ACCEPT_EDITS));
    expect(result).toMatchObject({ status: 'failed', workspaceUnchanged: true });
  });

  it('an Edit of a file whose folder is not writable fails with the workspace unchanged', async () => {
    const tools = await makeBuiltins({ executor: { writerLaunch: TEST_WRITER_LAUNCH } });
    const file = tools.write('locked/add.js', 'export const add = (a, b) => a - b;\n');
    tools.markRead(file);
    lock(path.dirname(file));
    const result = resultOf(await tools.run('Edit', { file_path: file, old_string: 'a - b', new_string: 'a + b' }, ACCEPT_EDITS));
    expect(result).toMatchObject({ status: 'failed', workspaceUnchanged: true });
    expect(fs.readFileSync(file, 'utf8')).toBe('export const add = (a, b) => a - b;\n');
  });

  it('a Write whose writer ended without an answer is a change', async () => {
    const tools = await makeBuiltins({ executor: { writerLaunch: SILENT_LAUNCH } });
    const file = path.join(path.dirname(tools.write('seed.txt', '')), 'new.txt');
    const result = resultOf(await tools.run('Write', { file_path: file, content: 'new\n' }, ACCEPT_EDITS));
    expect(result.status).toBe('failed');
    expect(result).not.toHaveProperty('workspaceUnchanged');
  });

  it('a completed Write carries no such fact', async () => {
    const tools = await makeBuiltins({ executor: { writerLaunch: TEST_WRITER_LAUNCH } });
    const file = path.join(path.dirname(tools.write('seed.txt', '')), 'new.txt');
    const result = resultOf(await tools.run('Write', { file_path: file, content: 'new\n' }, ACCEPT_EDITS));
    expect(result.status).toBe('completed');
    expect(result).not.toHaveProperty('workspaceUnchanged');
  });
});
