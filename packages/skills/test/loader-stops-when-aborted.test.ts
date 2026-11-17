import { describe, expect, it } from 'vitest';
import { createSkillLoader } from '@momonga/skills';
import { fakeSkillFileSystem, skillFile } from './fake-file-system.ts';

const HOME = '/home/u';

describe('a skill load stops at the first file read after its asker has gone', () => {
  it('lists no further directory once the request is aborted', async () => {
    const fileSystem = fakeSkillFileSystem({
      [`${HOME}/.agents/skills/pdf/SKILL.md`]: skillFile('pdf', 'Extract PDF text'),
      [`${HOME}/.agents/skills/zip/SKILL.md`]: skillFile('zip', 'Pack files'),
    });
    const request = new AbortController();
    const listDirectory = fileSystem.listDirectory;
    fileSystem.listDirectory = async (directory) => {
      request.abort(new Error('the request was closed'));
      return listDirectory(directory);
    };

    await expect(createSkillLoader({ home: HOME, fileSystem }).load({ projectRoot: '/work/app', trusted: true, signal: request.signal })).rejects.toThrow('the request was closed');

    expect(fileSystem.listings).toHaveLength(1);
  });
});
