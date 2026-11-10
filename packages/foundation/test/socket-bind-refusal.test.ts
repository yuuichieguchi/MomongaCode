import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setSocketBind, socketBindRefusalOf } from '@momonga/foundation';

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`bind failed: ${code}`), { code });

const DIRECTORY = '/var/run/momonga-refusal-target';
const INTENDED = path.join(DIRECTORY, `${'s'.repeat(60)}.sock`);
const BYTES = Buffer.byteLength(INTENDED);

describe('the refusal of a socket path by the bind measurement', () => {
  afterEach(() => setSocketBind(undefined));

  it('refuses nothing when the bind succeeds', async () => {
    setSocketBind(() => Promise.resolve());
    expect(await socketBindRefusalOf(INTENDED)).toBeUndefined();
  });

  it.each(['ENAMETOOLONG', 'EINVAL'])('refuses a length the system does not bind (%s) as unsupported', async (code) => {
    setSocketBind(() => Promise.reject(errno(code)));
    expect(await socketBindRefusalOf(INTENDED)).toEqual({ kind: 'unsupported', byteLength: BYTES, directory: DIRECTORY, code });
  });

  it.each(['EACCES', 'ENOENT'])('refuses a path that could not be measured (%s) as unmeasured with the reason', async (code) => {
    setSocketBind(() => Promise.reject(errno(code)));
    expect(await socketBindRefusalOf(INTENDED)).toEqual({ kind: 'unmeasured', byteLength: BYTES, directory: DIRECTORY, reason: code });
  });

  it('gives the message of an error without a code as the reason', async () => {
    setSocketBind(() => Promise.reject(new Error('the bind went wrong')));
    expect(await socketBindRefusalOf(INTENDED)).toEqual({ kind: 'unmeasured', byteLength: BYTES, directory: DIRECTORY, reason: 'the bind went wrong' });
  });
});
