import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodeFileSystem } from '@momonga/foundation';
import { PLAN_STORE_UNREADABLE_CODE, PLAN_STORE_UNWRITABLE_CODE } from '@momonga/protocol';
import { siwcBrowse } from '@momonga/testkit';
import { readActivePointer } from '../src/plan/active-account.ts';
import { createPlanSignIn } from '../src/plan/signin.ts';
import type { PlanSessions } from '../src/plan/session.ts';
import { CONDITION_WAIT, PROFILE_ID, createGatedFileSystem, readRecord, realSleep, recordingSerial, signInAtFake, signedIn, startHarness } from './plan-support.ts';
import type { GatedFileSystem, Harness, RecordingSerial } from './plan-support.ts';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const harness = async (): Promise<Harness> => {
  const h = await startHarness();
  harnesses.push(h);
  return h;
};

const work = { profile: PROFILE_ID, account: 'work' };
const home = { profile: PROFILE_ID, account: 'home' };
const third = { profile: PROFILE_ID, account: 'third' };

const gatedHarness = async (pointerSerial?: RecordingSerial): Promise<{ h: Harness; gated: GatedFileSystem }> => {
  let gated: GatedFileSystem | undefined;
  const h = await startHarness({
    wrapFileSystem: (base) => {
      gated = createGatedFileSystem(base);
      return gated.fileSystem;
    },
    ...(pointerSerial === undefined ? {} : { pointerSerial }),
  });
  harnesses.push(h);
  if (gated === undefined) throw new Error('the harness did not wrap its file system');
  return { h, gated };
};

const isActiveFile = (h: Harness) => (file: string): boolean => file === h.paths.active;

const PORT = 49152;

const NOT_AN_OBJECT = '"x"';

const notAnObjectCause = (h: Harness): string => `the active plan account file ${h.paths.active} is not a JSON object`;

const currentSessions = (h: Harness): PlanSessions =>
  new Proxy({} as PlanSessions, {
    get: (_target, property) => {
      const value = (h.sessions as Record<PropertyKey, unknown>)[property];
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(h.sessions) : value;
    },
  });

const signInFor = (h: Harness) =>
  createPlanSignIn({
    profiles: { [PROFILE_ID]: h.profile },
    sessions: currentSessions(h),
    clock: h.clock,
    outbound: (signal, use) => {
      signal.throwIfAborted();
      return use((url, init) => {
        h.fetchUrls.push(url);
        return fetch(url, init);
      });
    },
    lifetime: new AbortController().signal,
    sleep: realSleep,
    fileSystem: nodeFileSystem,
    hostFile: h.paths.host,
  });

const failureOf = async (promise: Promise<unknown>): Promise<{ code: unknown; message: unknown }> => {
  try {
    await promise;
  } catch (error) {
    const typed = error as { code?: unknown; message?: unknown };
    return { code: typed.code, message: typed.message };
  }
  throw new Error('expected the call to fail');
};

describe('one serializer for pointer writes, each built from the file as it is then (P-S5, S8, S9, C47)', () => {
  it('a pointer write reads the pointer file once, before it writes', async () => {
    const { h, gated } = await gatedHarness();
    await signedIn(h, 'work');
    await signedIn(h, 'home');
    await h.reopen({ accounts: [work, home] });
    const mark = gated.recorded.length;
    await h.sessions.selectActive(work, new AbortController().signal);
    await h.sessions.selectActive(home, new AbortController().signal);
    await signedIn(h, 'third');
    const since = gated.recorded.slice(mark).filter((call) => call.path === h.paths.active);
    expect(since.filter((call) => call.method === 'rename')).toHaveLength(3);
    expect(since.map((call) => call.method)).toEqual(['readOwnerOnlyTextFile', 'rename', 'readOwnerOnlyTextFile', 'rename', 'readOwnerOnlyTextFile', 'rename']);
  });

  it('two pointer writes go through the one serializer and queue behind each other', { timeout: 60_000 }, async () => {
    const serial = recordingSerial();
    const { h, gated } = await gatedHarness(serial);
    await signedIn(h, 'work');
    await signedIn(h, 'home');
    await h.reopen({ accounts: [work, home] });
    const base = serial.runs;
    const hold = gated.gate('rename', isActiveFile(h));
    const first = h.sessions.selectActive(work, new AbortController().signal);
    await hold.reached;
    const second = h.sessions.selectActive(home, new AbortController().signal);
    try {
      await vi.waitFor(() => expect(serial.runs - base).toBe(2), CONDITION_WAIT);
      expect(serial.active).toBe(1);
      expect(h.sessions.activeLabel(PROFILE_ID)).toBe('home');
    } finally {
      hold.release();
      await Promise.all([first, second]);
    }
    expect(serial.maxActive).toBe(1);
    const afterBase = (index: number): boolean => index > base;
    expect(serial.started.filter(afterBase)).toEqual([base + 1, base + 2]);
    expect(serial.finished.filter(afterBase)).toEqual([base + 1, base + 2]);
    expect(await readActivePointer(nodeFileSystem, h.paths.active)).toEqual({ [PROFILE_ID]: 'home' });
    expect(h.sessions.activeLabel(PROFILE_ID)).toBe('home');
  });

  it('an entry of a profile this build does not ship survives a pointer write', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    fs.writeFileSync(h.paths.active, JSON.stringify({ other: 'z' }));
    await h.reopen({ accounts: [work] });
    await h.sessions.selectActive(work, new AbortController().signal);
    expect(await readActivePointer(nodeFileSystem, h.paths.active)).toEqual({ other: 'z', [PROFILE_ID]: 'work' });
  });

  it('with a damaged pointer at open, begin rejects PLAN_STORE_UNREADABLE_CODE naming the file before anything is done', async () => {
    const h = await harness();
    fs.mkdirSync(h.paths.active.slice(0, h.paths.active.lastIndexOf('/')), { recursive: true });
    fs.writeFileSync(h.paths.active, NOT_AN_OBJECT, { mode: 0o600 });
    await h.reopen();
    const failure = await failureOf(signInFor(h).begin({ profile: PROFILE_ID, account: 'work', port: PORT }, new AbortController().signal));
    expect(failure).toEqual({ code: PLAN_STORE_UNREADABLE_CODE, message: notAnObjectCause(h) });
    expect(fs.existsSync(h.paths.host)).toBe(false);
    expect(h.fetchUrls).toEqual([]);
    expect(await readRecord(h, 'work')).toBeUndefined();
  });

  it('complete with a damaged pointer rejects PLAN_STORE_UNREADABLE_CODE before consuming: the attempt is still open and no token request was sent', async () => {
    const h = await harness();
    const signIn = signInFor(h);
    const { attemptId, authorizationUrl } = await signIn.begin({ profile: PROFILE_ID, account: 'work', port: PORT }, new AbortController().signal);
    const browsed = await siwcBrowse(authorizationUrl);
    if (browsed.redirect === undefined) throw new Error(`the fake refused the authorization: ${JSON.stringify(browsed.body)}`);
    fs.writeFileSync(h.paths.active, NOT_AN_OBJECT, { mode: 0o600 });
    await h.reopen();
    const failure = await failureOf(signIn.complete(attemptId, browsed.redirect.href, new AbortController().signal));
    expect(failure).toEqual({ code: PLAN_STORE_UNREADABLE_CODE, message: notAnObjectCause(h) });
    expect(h.fetchUrls).not.toContain(h.auth.tokenUrl);
    expect(h.auth.calls.tokenAuthorizationCode).toBe(0);
    expect(signIn.waiting()).toBe(true);
    fs.writeFileSync(h.paths.active, '{}');
    await expect(signIn.complete(attemptId, browsed.redirect.href, new AbortController().signal)).resolves.toMatchObject({ outcome: 'identity_unconfirmed' });
    await expect(signIn.confirm(attemptId, new AbortController().signal)).resolves.toMatchObject({ outcome: 'signed_in' });
  });

  it('a pointer write that fails after install rejects PLAN_STORE_UNWRITABLE_CODE naming the file, the record stays active, and selectActive then succeeds', async () => {
    const { h, gated } = await gatedHarness();
    const signIn = await signInAtFake(h);
    await h.sessions.register({ profile: PROFILE_ID, account: 'work', clientId: signIn.clientId, hostId: signIn.hostId }, new AbortController().signal);
    const pointer = gated.gate('rename', isActiveFile(h));
    const installed = failureOf(
      h.sessions.install({ profile: PROFILE_ID, account: 'work', clientId: signIn.clientId, hostId: signIn.hostId, subject: signIn.subject, email: signIn.email, idToken: signIn.idToken, tokens: signIn.tokens }, new AbortController().signal),
    );
    await pointer.reached;
    pointer.fail(new Error('EACCES'));
    expect(await installed).toEqual({ code: PLAN_STORE_UNWRITABLE_CODE, message: `the active plan account file ${h.paths.active} could not be written: EACCES` });
    expect((await readRecord(h, 'work'))?.['state']).toBe('active');
    await h.sessions.selectActive(work, new AbortController().signal);
    expect(await readActivePointer(nodeFileSystem, h.paths.active)).toEqual({ [PROFILE_ID]: 'work' });
  });

  it('repairing the file between two writes: the heal read clears the problem, listProblems loses the entry, and the write is built from the file\'s entries', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    fs.writeFileSync(h.paths.active, NOT_AN_OBJECT, { mode: 0o600 });
    await h.reopen({ accounts: [work] });
    expect(h.sessions.listProblems()).toEqual([{ file: 'plan-active.json', cause: notAnObjectCause(h) }]);
    fs.writeFileSync(h.paths.active, JSON.stringify({ other: 'z' }));
    await h.sessions.selectActive(work, new AbortController().signal);
    expect(h.sessions.listProblems()).toEqual([]);
    expect(await readActivePointer(nodeFileSystem, h.paths.active)).toEqual({ other: 'z', [PROFILE_ID]: 'work' });
    expect(h.sessions.activeLabel(PROFILE_ID)).toBe('work');
  });

  it('six concurrent pointer writes leave the file equal to the mirror', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    await signedIn(h, 'home');
    await signedIn(h, 'third');
    await h.reopen({ accounts: [work, home, third] });
    await Promise.all(['work', 'home', 'third', 'work', 'third', 'home'].map((account) => h.sessions.selectActive({ profile: PROFILE_ID, account }, new AbortController().signal)));
    const file = JSON.parse(fs.readFileSync(h.paths.active, 'utf8')) as Record<string, unknown>;
    expect(file[PROFILE_ID]).toBe(h.sessions.activeLabel(PROFILE_ID));
  });
});
