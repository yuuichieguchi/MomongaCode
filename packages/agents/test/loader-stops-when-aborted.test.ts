import { describe, expect, it } from 'vitest';
import type { SkillFileSystem } from '@momonga/skills';
import { createAgentLoader } from '../src/loader.ts';

describe('an agent load stops at the first file read after its asker has gone', () => {
  it('lists no further directory once the request is aborted', async () => {
    const listed: string[] = [];
    const request = new AbortController();
    const fileSystem: SkillFileSystem = {
      listDirectory: async (directory) => {
        listed.push(directory);
        request.abort(new Error('the request was closed'));
        return [];
      },
      readText: async () => undefined,
      realpath: async (target) => target,
    };

    await expect(createAgentLoader({ home: '/home/u', fileSystem }).load({ projectRoot: '/work/app', trusted: true, projectAgentApproved: () => true, signal: request.signal })).rejects.toThrow('the request was closed');

    expect(listed).toHaveLength(1);
  });
});
