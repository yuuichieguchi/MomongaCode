import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLAN_SIGN_IN_DEFAULTS } from '../src/defaults.ts';
import { sendRefresh } from '../src/plan/refresh.ts';
import { revokeRefreshToken } from '../src/plan/revoke.ts';
import { ATTEMPT_BOUND_MS, CHUNK_BYTES, DISCOVERY_URL, ISSUER, REVOKE_URL, TOKEN_URL, WAIT_POLICY, boundOnlySleep, recordedFetch, sendClock, sendProfile, streamedBody } from './plan-send-fakes.ts';
import type { PulledBody } from './plan-send-fakes.ts';

const CAP = PLAN_SIGN_IN_DEFAULTS.authBodyBytes;
const OVERSIZE_BYTES = 8 * CAP;
const PULL_LIMIT = CAP + 2 * CHUNK_BYTES;
const PLAN_SOURCE = path.resolve(import.meta.dirname, '..', 'src', 'plan');

const refreshWith = (fetch: ReturnType<typeof recordedFetch>['fetch']) =>
  sendRefresh({
    ports: { fetch, sleep: boundOnlySleep({ parkBackoffs: false }).sleep },
    clock: sendClock(),
    tokenUrl: TOKEN_URL,
    form: { grant_type: 'refresh_token', refresh_token: 'refresh-under-test', client_id: 'client-under-test' },
    attempts: 3,
    attemptTimeoutMs: ATTEMPT_BOUND_MS,
    waitPolicy: WAIT_POLICY,
    maxBodyBytes: CAP,
    signal: new AbortController().signal,
  });

const revokeWith = (fetch: ReturnType<typeof recordedFetch>['fetch']) =>
  revokeRefreshToken({
    ports: { fetch, sleep: boundOnlySleep({ parkBackoffs: false }).sleep },
    clock: sendClock(),
    profile: sendProfile(),
    clientId: 'client-under-test',
    refreshToken: 'refresh-under-test',
    attempts: 3,
    attemptTimeoutMs: ATTEMPT_BOUND_MS,
    waitPolicy: WAIT_POLICY,
    maxBodyBytes: CAP,
    signal: new AbortController().signal,
  });

const discoveryDocument = (): Response => new Response(JSON.stringify({ issuer: ISSUER, revocation_endpoint: REVOKE_URL }), { status: 200 });

describe('one sender reads every plan answer under the cap (P-G2)', () => {
  it('a 200 refresh answer over the cap is transient, never resent, and the fetch is called once', async () => {
    const bodies: PulledBody[] = [];
    const fake = recordedFetch(() => {
      const body = streamedBody(200, OVERSIZE_BYTES);
      bodies.push(body);
      return body.response;
    });
    expect(await refreshWith(fake.fetch)).toEqual({ kind: 'transient', attempts: 1 });
    expect(fake.calls).toHaveLength(1);
    for (const body of bodies) expect(body.pulled()).toBeLessThanOrEqual(PULL_LIMIT);
  });

  it('a 503 refresh answer over the cap is transient and resent', async () => {
    const bodies: PulledBody[] = [];
    const fake = recordedFetch(() => {
      const body = streamedBody(503, OVERSIZE_BYTES);
      bodies.push(body);
      return body.response;
    });
    expect(await refreshWith(fake.fetch)).toEqual({ kind: 'transient', attempts: 3 });
    expect(fake.calls).toHaveLength(3);
    for (const body of bodies) expect(body.pulled()).toBeLessThanOrEqual(PULL_LIMIT);
  });

  it('a discovery document over the cap is unconfirmed and no revocation POST is sent', async () => {
    const bodies: PulledBody[] = [];
    const fake = recordedFetch(() => {
      const body = streamedBody(200, OVERSIZE_BYTES);
      bodies.push(body);
      return body.response;
    });
    expect(await revokeWith(fake.fetch)).toBe('unconfirmed');
    expect(fake.calls.map((call) => call.url)).toEqual([DISCOVERY_URL]);
    for (const body of bodies) expect(body.pulled()).toBeLessThanOrEqual(PULL_LIMIT);
  });

  it('a revocation answer over the cap is unconfirmed', async () => {
    const bodies: PulledBody[] = [];
    const fake = recordedFetch((url) => {
      if (url === DISCOVERY_URL) return discoveryDocument();
      const body = streamedBody(200, OVERSIZE_BYTES);
      bodies.push(body);
      return body.response;
    });
    expect(await revokeWith(fake.fetch)).toBe('unconfirmed');
    expect(fake.calls.filter((call) => call.url === REVOKE_URL)).toHaveLength(1);
    expect(bodies).toHaveLength(1);
    for (const body of bodies) expect(body.pulled()).toBeLessThanOrEqual(PULL_LIMIT);
  });

  it('the plan directory has one sender: capped-send.ts does not exist and no plan source calls response.text()', () => {
    expect(fs.existsSync(path.join(PLAN_SOURCE, 'capped-send.ts'))).toBe(false);
    const calls = fs
      .readdirSync(PLAN_SOURCE)
      .filter((name) => name.endsWith('.ts'))
      .flatMap((name) => fs.readFileSync(path.join(PLAN_SOURCE, name), 'utf8').split('\n').map((line, index) => ({ at: `${name}:${index + 1}`, line })))
      .filter(({ line }) => /\.text\(\)/.test(line))
      .map(({ at }) => at);
    expect(calls).toEqual([]);
  });
});
