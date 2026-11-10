import { afterEach, describe, expect, it } from 'vitest';
import { PROFILE_ID, rawRecord, readRecord, startHarness } from './plan-support.ts';
import type { Harness } from './plan-support.ts';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const HOST = 'urn:ietf:params:oauth:jwk-thumbprint:sha-256:host';
const TOKEN_FIELDS = ['access_token', 'refresh_token', 'id_token', 'subject', 'email'];

const register = (h: Harness, clientId: string) => h.sessions.register({ profile: PROFILE_ID, account: 'work', clientId, hostId: HOST });

describe('the step-4 compare-and-write of the registered record (O-R5-5 item 2, I-S4)', () => {
  it('writes client A, refuses client B leaving the bytes, and accepts client A again without a change', async () => {
    const h = await startHarness();
    harnesses.push(h);
    expect(await register(h, 'client-a')).toEqual({ outcome: 'registered' });
    const written = await rawRecord(h, 'work');
    expect(await readRecord(h, 'work')).toMatchObject({ state: 'registered', client_id: 'client-a', ext_agent_host_id: HOST, account: 'work' });
    expect(await register(h, 'client-b')).toEqual({ outcome: 'rejected', reason: 'registration_superseded' });
    expect(await rawRecord(h, 'work')).toBe(written);
    expect(await register(h, 'client-a')).toEqual({ outcome: 'registered' });
    expect(await rawRecord(h, 'work')).toBe(written);
    const record = (await readRecord(h, 'work')) ?? {};
    for (const field of TOKEN_FIELDS) expect(record).not.toHaveProperty(field);
  });
});
