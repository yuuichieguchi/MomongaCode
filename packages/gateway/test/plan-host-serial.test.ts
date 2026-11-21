import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeFileSystem } from '@momonga/foundation';
import { PLAN_HOST_IDENTITY_UNAVAILABLE_CODE, PLAN_SIGN_IN_PENDING_CODE } from '@momonga/protocol';
import { createPlanSignIn } from '../src/plan/signin.ts';
import { PROFILE_ID, createGatedFileSystem, realSleep, startHarness } from './plan-support.ts';
import type { GatedFileSystem, Harness } from './plan-support.ts';
import { testKernelLock } from '@momonga/testkit';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const PORT = 49152;

const setup = async () => {
  const h = await startHarness();
  harnesses.push(h);
  const gated: GatedFileSystem = createGatedFileSystem(nodeFileSystem);
  const signIn = createPlanSignIn({
    lock: testKernelLock(),
    profiles: { [PROFILE_ID]: h.profile },
    sessions: h.sessions,
    clock: h.clock,
    outbound: (signal, use) => {
      signal.throwIfAborted();
      return use((url, init) => fetch(url, init));
    },
    lifetime: h.sessions.lifetime,
    sleep: realSleep,
    fileSystem: gated.fileSystem,
    hostFile: h.paths.host,
  });
  const isHost = (file: string): boolean => file === h.paths.host;
  const fileHostId = (): string => String((JSON.parse(fs.readFileSync(h.paths.host, 'utf8')) as Record<string, unknown>)['hostId']);
  const hostIdOf = (authorizationUrl: string): string | null => {
    const client = h.profile.oauth!.client;
    if (client.kind !== 'dynamic_registration') throw new Error('expected a dynamic_registration profile');
    return new URL(authorizationUrl).searchParams.get(client.registrationParameters.hostId);
  };
  const begin = (account = 'work') => signIn.begin({ profile: PROFILE_ID, account, port: PORT }, new AbortController().signal);
  return { h, gated, signIn, isHost, fileHostId, hostIdOf, begin };
};

const failureOf = async (promise: Promise<unknown>): Promise<{ code: unknown; status: unknown }> => {
  try {
    await promise;
  } catch (error) {
    const typed = error as { code?: unknown; status?: unknown; body?: { code?: unknown } };
    return { code: typed.body?.code ?? typed.code, status: typed.status };
  }
  throw new Error('expected the call to fail');
};

describe('one serializer for the host identity file (P-G5, S10)', () => {
  it('a resetHost started while a begin holds its host read waits for it, then rejects plan_sign_in_pending, and the host file keeps the id the attempt carries', async () => {
    const { gated, signIn, isHost, fileHostId, hostIdOf, begin } = await setup();
    const read = gated.gate('readOwnerOnlyTextFile', isHost);
    const begun = begin();
    await read.reached;
    const reset = failureOf(signIn.resetHost());
    read.release();
    const { authorizationUrl } = await begun;
    expect(await reset).toEqual({ code: PLAN_SIGN_IN_PENDING_CODE, status: 409 });
    expect(hostIdOf(authorizationUrl)).toBe(fileHostId());
  });

  it('a begin started during the reset\'s write reads the new host id', async () => {
    const { gated, signIn, isHost, fileHostId, hostIdOf, begin } = await setup();
    const write = gated.gate('rename', isHost);
    const reset = signIn.resetHost();
    await write.reached;
    const begun = begin();
    write.release();
    const [reseted, { authorizationUrl }] = await Promise.all([reset, begun]);
    expect(hostIdOf(authorizationUrl)).toBe(fileHostId());
    expect(reseted.hostId).toBe(fileHostId());
  });

  it('a begin, a reset and a begin issued together settle in issue order: each attempt carries the file\'s id at the moment it registered', async () => {
    const { signIn, fileHostId, hostIdOf, begin } = await setup();
    const first = begin('work');
    const reset = failureOf(signIn.resetHost());
    const second = begin('home');
    const [firstBegun, refused, secondBegun] = await Promise.all([first, reset, second]);
    expect(refused).toEqual({ code: PLAN_SIGN_IN_PENDING_CODE, status: 409 });
    expect(hostIdOf(firstBegun.authorizationUrl)).toBe(fileHostId());
    expect(hostIdOf(secondBegun.authorizationUrl)).toBe(fileHostId());
  });

  it('a begin whose host read fails releases the serializer', async () => {
    const { gated, signIn, isHost, begin } = await setup();
    const read = gated.gate('readOwnerOnlyTextFile', isHost);
    const begun = failureOf(begin());
    await read.reached;
    read.fail(new Error('read failed'));
    expect((await begun).code).toBe(PLAN_HOST_IDENTITY_UNAVAILABLE_CODE);
    await expect(signIn.resetHost()).resolves.toMatchObject({ hostId: expect.any(String) });
  });
});
