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
});
