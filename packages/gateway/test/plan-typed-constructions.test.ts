import { describe, expect, it } from 'vitest';
import { nodeFileSystem } from '@momonga/foundation';
import type { FileSystem } from '@momonga/foundation';
import { ensureHostIdentity } from '../src/plan/host-identity.ts';
import { tokenResponseOf } from '../src/plan/refresh.ts';
import { testKernelLock } from '@momonga/testkit';

const HOST_FILE = '/nowhere/state/plan-host.json';

const throwingRead = (thrown: unknown): FileSystem => ({
  ...nodeFileSystem,
  readOwnerOnlyTextFile: () => Promise.reject(thrown),
});

describe('a host identity file that cannot be read names what was thrown, whatever its type (GR-cast CA-2)', () => {
  it('an Error gives its message', async () => {
    await expect(ensureHostIdentity(throwingRead(new Error('permission denied')), HOST_FILE, { lock: testKernelLock(), accountsExist: true })).rejects.toThrow('cannot be read (permission denied)');
  });

  it('a value that is not an Error gives its text, never "undefined"', async () => {
    await expect(ensureHostIdentity(throwingRead('the disk went away'), HOST_FILE, { lock: testKernelLock(), accountsExist: true })).rejects.toThrow('cannot be read (the disk went away)');
  });
});

describe('a token response is built from its checked fields (GR-cast CA-3, CA-4)', () => {
  const body = { access_token: 'access', token_type: 'Bearer', expires_in: 3600, scope: 'openid', refresh_token: 'refresh', id_token: 'id', earliest_refresh_at: 'opaque', unknown_member: { nested: true } };

  it('keeps the known fields and nothing else', () => {
    expect(tokenResponseOf(body, { refreshRequired: true })).toEqual({
      tokens: { access_token: 'access', token_type: 'Bearer', expires_in: 3600, scope: 'openid', refresh_token: 'refresh', id_token: 'id', earliest_refresh_at: 'opaque' },
    });
  });

  it('leaves absent optional fields absent', () => {
    const { refresh_token: _refresh, id_token: _id, earliest_refresh_at: _earliest, unknown_member: _unknown, ...required } = body;
    expect(tokenResponseOf(required, { refreshRequired: false })).toEqual({ tokens: required });
  });

  it('names the problem of a body that fails a check', () => {
    expect(tokenResponseOf({ ...body, expires_in: 0 }, { refreshRequired: false })).toEqual({ problem: 'the token response has no positive integer expires_in' });
    expect(tokenResponseOf('text', { refreshRequired: false })).toEqual({ problem: 'the token response is not a JSON object' });
  });

  it('keeps earliest_refresh_at as text when it is a string or a finite number and drops any other shape, never refusing for it', () => {
    const earliestOf = (value: unknown): unknown => {
      const reading = tokenResponseOf({ ...body, earliest_refresh_at: value }, { refreshRequired: true });
      if ('problem' in reading) throw new Error(reading.problem);
      return reading.tokens.earliest_refresh_at;
    };
    expect(earliestOf('opaque')).toBe('opaque');
    expect(earliestOf(1_800_000_123)).toBe('1800000123');
    expect(earliestOf(1_800_000_123.5)).toBe('1800000123.5');
    expect(earliestOf(null)).toBeUndefined();
    expect(earliestOf(undefined)).toBeUndefined();
    expect(earliestOf({ at: 1 })).toBeUndefined();
    expect(earliestOf([1])).toBeUndefined();
    expect(earliestOf(true)).toBeUndefined();
  });

  it('still refuses a response that lacks a field the product needs', () => {
    const { access_token: _access, ...noAccess } = body;
    expect(tokenResponseOf(noAccess, { refreshRequired: true })).toEqual({ problem: 'the token response has no access token' });
    const { refresh_token: _refresh, ...noRefresh } = body;
    expect(tokenResponseOf(noRefresh, { refreshRequired: true })).toEqual({ problem: 'the token response has no refresh token' });
    expect(tokenResponseOf({ ...body, token_type: 'mac' }, { refreshRequired: true })).toEqual({ problem: 'the token response is not a Bearer token' });
  });
});
