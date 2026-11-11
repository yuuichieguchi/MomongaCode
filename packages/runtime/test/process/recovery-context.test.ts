import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as runtime from '@momonga/runtime';
import { fakePolicyFilesystem, NEVER_CANCELLED, testKernelLock } from '@momonga/testkit';
import { createSession, makeDir, makeLogger, makeTempHome, openStore } from './helpers.ts';

const failingFilesystem = () => {
  const touched: string[] = [];
  const eio = (method: string) => (): never => {
    touched.push(method);
    throw Object.assign(new Error(`EIO: injected ${method}`), { code: 'EIO' });
  };
  const base = fakePolicyFilesystem();
  const filesystem: typeof base = {
    ...base,
    canonicalise: eio('canonicalise'),
    volumeProbe: eio('volumeProbe'),
    resolveProgram: eio('resolveProgram'),
    expandGlob: eio('expandGlob'),
    readEntry: eio('readEntry'),
    readNoFollow: eio('readNoFollow'),
  };
  return { filesystem, touched };
};

describe('recoveryContextFor needs no protected set (3.15 (a) Recovery)', () => {
  it('returns roots, tmpDir and env without calling the policy filesystem', async () => {
    const temp = await makeTempHome();
    const { store, clock } = openStore(temp);
    const sessionStates = runtime.createSessionStates({ clock, store, logger: makeLogger(), releaseScratch: () => undefined });
    const extra = makeDir(temp.root, 'extra');
    const session = createSession(store, temp.project, { additionalDirectories: [extra] });
    const { filesystem, touched } = failingFilesystem();
    const recoveryContextFor = runtime.createRecoveryContextFor({ lock: testKernelLock(), paths: temp.paths, home: temp.home, sessionStates, fs: filesystem });
    const env = Object.freeze({ PLAIN: '1' });

    const context = await recoveryContextFor(session, { signal: NEVER_CANCELLED, env });

    expect(context.roots).toEqual([temp.project, extra]);
    expect(context.tmpDir).toBe(path.join(temp.paths.tmp.sessions, session.id));
    expect(fs.statSync(context.tmpDir).isDirectory()).toBe(true);
    expect(context.env).toBe(env);
    expect(touched).toEqual([]);
  });
});

describe('an abort while the session scratch directory is prepared', () => {
  it('leaves recoveryContextFor as the abort reason of the asker, not as a ConfigError', async () => {
    const temp = await makeTempHome();
    const { store, clock } = openStore(temp);
    const sessionStates = runtime.createSessionStates({ clock, store, logger: makeLogger(), releaseScratch: () => undefined });
    const session = createSession(store, temp.project, {});
    const asker = new AbortController();
    const reason = new Error('the client left');
    const recoveryContextFor = runtime.createRecoveryContextFor({
      lock: testKernelLock(),
      paths: temp.paths,
      home: temp.home,
      sessionStates,
      fs: fakePolicyFilesystem(),
      ensureSessionTmpDir: async () => {
        asker.abort(reason);
        throw new Error('the directory could not be prepared');
      },
    });

    await expect(recoveryContextFor(session, { signal: asker.signal, env: {} })).rejects.toBe(reason);
  });
});
