import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeFileSystem } from '@momonga/foundation';
import type { FileSystem } from '@momonga/foundation';
import type { RuntimeStore } from '@momonga/store';
import { NEVER_CANCELLED, createFakeClock } from '@momonga/testkit';
import { START_MS, enqueue, makeStoreDir, newSession, openStoreAt } from './helpers.ts';

type Opened = { store: RuntimeStore; root: string };

const refusal = (code: string, file: string): Error => Object.assign(new Error(`${code}: ${file}`), { code });

const openWith = (overrides: (root: string) => Partial<FileSystem> = () => ({})): Opened => {
  const root = fs.realpathSync(makeStoreDir());
  const store = openStoreAt(path.join(root, 'runtime.db'), createFakeClock(START_MS), { home: path.join(root, 'home'), fileSystem: { ...nodeFileSystem, ...overrides(root) } });
  return { store, root };
};

describe('a trust decision for a path that cannot be resolved', () => {
  it('reads the decision of the nearest existing ancestor for a path that does not exist', async () => {
    const { store, root } = openWith();
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    await store.trust.setAsked(project, 'trusted', NEVER_CANCELLED);

    expect(await store.trust.decisionAsked(path.join(project, 'gone', 'deeper'), NEVER_CANCELLED)).toEqual({ decision: 'trusted', inheritedFrom: project });
  });

  it('answers no decision for a path that does not exist under no decided ancestor', async () => {
    const { store, root } = openWith();

    expect(await store.trust.decisionAsked(path.join(root, 'gone'), NEVER_CANCELLED)).toEqual({ decision: null });
  });

  it('resolves the existing part of a path that does not exist through its links', async () => {
    const { store, root } = openWith();
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    fs.symlinkSync(project, path.join(root, 'link'));
    await store.trust.setAsked(project, 'untrusted', NEVER_CANCELLED);

    expect(await store.trust.decisionAsked(path.join(root, 'link', 'gone'), NEVER_CANCELLED)).toEqual({ decision: 'untrusted', inheritedFrom: project });
  });

  it('gives the caller the refusal of a path it may not read', async () => {
    const { store, root } = openWith((dir) => ({
      realpath: async (file) => {
        if (file === path.join(dir, 'closed')) throw refusal('EACCES', file);
        return nodeFileSystem.realpath(file);
      },
    }));

    await expect(store.trust.decisionAsked(path.join(root, 'closed'), NEVER_CANCELLED)).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('gives the caller the error of a loop of links', async () => {
    const { store, root } = openWith();
    fs.symlinkSync(path.join(root, 'b'), path.join(root, 'a'));
    fs.symlinkSync(path.join(root, 'a'), path.join(root, 'b'));

    await expect(store.trust.decisionAsked(path.join(root, 'a'), NEVER_CANCELLED)).rejects.toMatchObject({ code: 'ELOOP' });
  });

  it('creates no run with a guessed origin when the folder of the session cannot be resolved', async () => {
    const { store, root } = openWith((dir) => ({
      realpath: async (file) => {
        if (file === path.join(dir, 'closed')) throw refusal('EIO', file);
        return nodeFileSystem.realpath(file);
      },
    }));
    const session = newSession(store, path.join(root, 'closed'));

    await expect(enqueue(store, session.id)).rejects.toMatchObject({ code: 'EIO' });
    expect(store.listRuns(session.id)).toEqual([]);
  });

  it('gives the caller the refusal of a path it may not probe when a decision is cleared', async () => {
    const { store, root } = openWith((dir) => ({
      access: async (file, check) => {
        if (file === path.join(dir, 'closed')) throw refusal('EACCES', file);
        return nodeFileSystem.access(file, check);
      },
    }));

    await expect(store.trust.clearAsked(path.join(root, 'closed'), NEVER_CANCELLED)).rejects.toMatchObject({ code: 'EACCES' });
  });
});
