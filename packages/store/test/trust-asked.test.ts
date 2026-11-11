import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RuntimeStore } from '@momonga/store';
import { createFakeClock } from '@momonga/testkit';
import { START_MS, makeStoreDir, openStoreAt } from './helpers.ts';

type TrustTree = { root: string; home: string; store: RuntimeStore };

const makeTrustTree = (): TrustTree => {
  const root = fs.realpathSync.native(makeStoreDir());
  const home = path.join(root, 'Home');
  fs.mkdirSync(home, { mode: 0o700 });
  return { root, home, store: openStoreAt(path.join(root, 'runtime.db'), createFakeClock(START_MS), { home }) };
};

const mkdir = (directory: string): string => {
  fs.mkdirSync(directory, { recursive: true });
  return fs.realpathSync.native(directory);
};

const live = (): AbortSignal => new AbortController().signal;

describe('trust decisions asked under the signal of the asker', () => {
  it('answers what the synchronous decision answers: exact, inherited, exact only above the home, and none', async () => {
    const tree = makeTrustTree();
    const work = mkdir(path.join(tree.root, 'work'));
    const app = mkdir(path.join(work, 'app'));
    const inHome = mkdir(path.join(tree.home, 'project'));
    const other = mkdir(path.join(tree.root, 'other'));
    await tree.store.trust.setAsked(work, 'trusted', live());
    await tree.store.trust.setAsked(tree.root, 'trusted', live());
    for (const target of [work, app, inHome, other, tree.home, path.join(tree.root, 'missing')]) {
      expect(await tree.store.trust.decisionAsked(target, live()), target).toEqual(tree.store.trust.decisionFor(target));
    }
    expect(await tree.store.trust.decisionAsked(app, live())).toEqual({ decision: 'trusted', inheritedFrom: work });
    expect(await tree.store.trust.decisionAsked(path.join(tree.root, 'missing'), live())).toEqual({ decision: null });
  });

  it('stores a decision under the real path, as the synchronous set does', async () => {
    const tree = makeTrustTree();
    const real = mkdir(path.join(tree.root, 'real'));
    const alias = path.join(tree.root, 'alias');
    fs.symlinkSync(real, alias, 'dir');
    await tree.store.trust.setAsked(alias, 'trusted', live());
    expect(tree.store.trust.get(real)).toBe('trusted');
  });

  it('refuses to trust the filesystem root', async () => {
    const tree = makeTrustTree();
    await expect(tree.store.trust.setAsked(path.parse(tree.root).root, 'trusted', live())).rejects.toThrow('refusing to trust the filesystem root');
  });

  it('clears the decision of a folder that exists and of one that is gone', async () => {
    const tree = makeTrustTree();
    const kept = mkdir(path.join(tree.root, 'kept'));
    const gone = mkdir(path.join(tree.root, 'gone'));
    tree.store.trust.set(kept, 'trusted');
    tree.store.trust.set(gone, 'trusted');
    fs.rmdirSync(gone);
    await tree.store.trust.clearAsked(kept, live());
    await tree.store.trust.clearAsked(gone, live());
    expect(tree.store.trust.get(kept)).toBeUndefined();
    fs.mkdirSync(gone);
    expect(tree.store.trust.get(gone)).toBeUndefined();
  });

  it('ends with the reason of the asker when its signal has aborted: an abort is never the answer "no decision"', async () => {
    const tree = makeTrustTree();
    const work = mkdir(path.join(tree.root, 'work'));
    tree.store.trust.set(work, 'trusted');
    const reason = new Error('the request ended');
    await expect(tree.store.trust.decisionAsked(work, AbortSignal.abort(reason))).rejects.toBe(reason);
    await expect(tree.store.trust.setAsked(work, 'untrusted', AbortSignal.abort(reason))).rejects.toBe(reason);
    await expect(tree.store.trust.clearAsked(work, AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(tree.store.trust.get(work)).toBe('trusted');
  });
});
