import fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONDITION_WAIT, PAUSE_CODE, PROFILE_ID, createGatedFileSystem, holdingOneWrite, readRecord, signInAtFake, signedIn, startHarness } from './plan-support.ts';
import type { FakeSignIn, GatedFileSystem, Harness } from './plan-support.ts';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const gatedHarness = async (): Promise<{ h: Harness; gated: GatedFileSystem }> => {
  let gated: GatedFileSystem | undefined;
  const h = await startHarness({
    wrapFileSystem: (base) => {
      gated = createGatedFileSystem(base);
      return gated.fileSystem;
    },
  });
  harnesses.push(h);
  if (gated === undefined) throw new Error('the harness did not wrap its file system');
  return { h, gated };
};

const work = { profile: PROFILE_ID, account: 'work' };
const home = { profile: PROFILE_ID, account: 'home' };

const signal = (): AbortSignal => new AbortController().signal;

const isActiveFile = (h: Harness) => (file: string): boolean => file === h.paths.active;

const pointerOf = async (h: Harness): Promise<unknown> => JSON.parse(await fs.readFile(h.paths.active, 'utf8'));

const installOf = (h: Harness, signIn: FakeSignIn) =>
  h.sessions.install(
    { profile: PROFILE_ID, account: 'work', clientId: signIn.clientId, hostId: signIn.hostId, subject: signIn.subject, email: signIn.email, idToken: signIn.idToken, tokens: signIn.tokens },
    signal(),
  );

describe('the record an install writes and the record in memory agree (F13, G9-5)', () => {
  it('the record a new install writes holds no pause of the sign-in it replaces', async () => {
    const { h } = await gatedHarness();
    const first = await signedIn(h, 'work');
    await h.sessions.authSource(work).pause({ code: PAUSE_CODE }, signal());
    expect((await readRecord(h, 'work'))?.['paused']).toEqual({});
    await installOf(h, await signInAtFake(h, { clientId: first.clientId }));
    expect((await readRecord(h, 'work'))?.['paused']).toBeUndefined();
    expect(h.sessions.authSource(work).status().paused).toBeUndefined();
  });

  it('a pause saved after the install wrote its record and before the install returns stays in memory as it is on disk', async () => {
    const { h, gated } = await gatedHarness();
    const first = await signedIn(h, 'work');
    const again = await signInAtFake(h, { clientId: first.clientId });
    const pointerWrite = gated.gate('rename', isActiveFile(h));
    const installing = installOf(h, again);
    await pointerWrite.reached;
    await h.sessions.authSource(work).pause({ code: PAUSE_CODE }, signal());
    pointerWrite.release();
    expect(await installing).toMatchObject({ outcome: 'signed_in' });
    expect((await readRecord(h, 'work'))?.['paused']).toEqual({});
    expect(h.sessions.authSource(work).status().paused).toEqual({});
  });
});
