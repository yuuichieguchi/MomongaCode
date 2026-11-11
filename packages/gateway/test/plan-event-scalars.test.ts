import { afterEach, describe, expect, it } from 'vitest';
import { nodeFileSystem } from '@momonga/foundation';
import { PLAN_CREDENTIAL_UNAVAILABLE_CODE, PLAN_HOST_IDENTITY_UNAVAILABLE_CODE } from '@momonga/protocol';
import { PlanCredentialError } from '../src/plan/auth-source.ts';
import { EVENT_SCALAR_CHARS, eventScalar } from '../src/plan/events.ts';
import { createPlanSignIn } from '../src/plan/signin.ts';
import { browse } from './plan-signin-support.ts';
import { NEVER_ENDED, PROFILE_ID, START_MS, realSleep, signedIn, startHarness, toRefreshWindow } from './plan-support.ts';
import type { Harness } from './plan-support.ts';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const work = { profile: PROFILE_ID, account: 'work' };

const PRINTABLE = /^[\x20-\x7e]*$/;

const eventsNamed = (h: Harness, name: string): Array<Record<string, unknown>> => h.events.filter((event) => event.name === name).map((event) => event.data);

describe('a scalar taken from an upstream answer into an event: one cut, one character rule (N-G6-2)', () => {
  it('a 300-character kid with a newline gives 128 printable characters', () => {
    const kid = `kid\n${'k'.repeat(296)}`;
    const shown = eventScalar(kid);
    expect(shown).toHaveLength(EVENT_SCALAR_CHARS);
    expect(EVENT_SCALAR_CHARS).toBe(128);
    expect(shown).toMatch(PRINTABLE);
    expect(shown.startsWith('kid?kkk')).toBe(true);
  });

  it('replaces every character outside printable ASCII and keeps a short printable value as it is', () => {
    expect(eventScalar('RS256')).toBe('RS256');
    expect(eventScalar('a\u0000b\u007fcéd e')).toBe('a?b?c?d?e');
  });

  it('plan.refresh carries the earliest_refresh_at of the token answer through the rule', async () => {
    const h = await startHarness();
    harnesses.push(h);
    await signedIn(h, 'work');
    h.rewriteRefresh((body) => ({ ...body, earliest_refresh_at: `at\r\n${'9'.repeat(300)}` }));
    toRefreshWindow(h, START_MS);
    await h.sessions.authSource(work).read(NEVER_ENDED);
    const [refresh] = eventsNamed(h, 'plan.refresh');
    expect(refresh?.['outcome']).toBe('adopted');
    expect(refresh?.['earliestRefreshAt']).toBe(`at??${'9'.repeat(124)}`);
  });
});

describe('the event rows of the ends nobody tested (G6)', () => {
  it('plan.rejected answers internal and plan.refresh ends failed with internal when the refresh throws', async () => {
    let broken = false;
    const h = await startHarness({
      wrapSleep: (inner) => (ms, signal) => (broken && ms !== 15_000 ? Promise.reject(new Error('the timer port broke')) : inner(ms, signal)),
    });
    harnesses.push(h);
    await signedIn(h, 'work');
    h.clock.advance(120_000);
    const source = h.sessions.authSource(work);
    const { generation } = await source.read(NEVER_ENDED);
    h.auth.scriptToken('refresh_token', [{ kind: 'http', status: 503 }]);
    broken = true;
    await expect(source.rejected(generation, NEVER_ENDED)).rejects.toThrow('the timer port broke');
    expect(eventsNamed(h, 'plan.rejected')).toMatchObject([{ answer: 'internal', generation }]);
    expect(eventsNamed(h, 'plan.refresh')).toMatchObject([{ outcome: 'failed', code: 'internal' }]);
  });

  it.each([PLAN_CREDENTIAL_UNAVAILABLE_CODE, PLAN_HOST_IDENTITY_UNAVAILABLE_CODE])('plan.sign_in ends failed with %s when the registration fails with it', async (code) => {
    const h = await startHarness();
    harnesses.push(h);
    const signIn = createPlanSignIn({
      profiles: { [PROFILE_ID]: h.profile },
      sessions: { ...h.sessions, register: () => Promise.reject(new PlanCredentialError(code, 'the record store did not answer', false)) },
      clock: h.clock,
      outbound: (signal, use) => {
        signal.throwIfAborted();
        return use((url, init) => fetch(url, init));
      },
      lifetime: h.sessions.lifetime,
      sleep: realSleep,
      fileSystem: nodeFileSystem,
      hostFile: h.paths.host,
      events: (name, data) => {
        h.events.push({ name, data: data as Record<string, unknown> });
      },
    });
    const begun = await signIn.begin({ profile: PROFILE_ID, account: 'work', port: 49152 }, NEVER_ENDED);
    const callback = await browse(begun.authorizationUrl);
    await expect(signIn.complete(begun.attemptId, callback.toString(), NEVER_ENDED)).rejects.toMatchObject({ code });
    expect(eventsNamed(h, 'plan.sign_in')).toMatchObject([{ outcome: 'failed', failure: code, endStep: 4 }]);
  });
});
