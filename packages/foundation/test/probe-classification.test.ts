import { describe, expect, it } from 'vitest';
import { ProbeFailedError, classifyProbeCause, failureOfError, isTransientFailure, judgeProcessIdentity, probeFailed, valueOrThrow } from '@momonga/foundation';

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: injected`), { code });

describe('classifyProbeCause', () => {
  it.each(['EMFILE', 'ENFILE', 'EAGAIN', 'EBUSY', 'ENOMEM', 'EINTR', 'ETIMEDOUT', 'EIO'])('treats errno %s as transient', (code) => {
    expect(classifyProbeCause({ kind: 'errno', code, detail: code })).toBe('transient');
  });

  it.each(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ELOOP'])('treats errno %s as deterministic', (code) => {
    expect(classifyProbeCause({ kind: 'errno', code, detail: code })).toBe('deterministic');
  });

  it('treats a timeout as transient and a tool exit, unparseable output and an unrecognised error as deterministic', () => {
    expect(classifyProbeCause({ kind: 'timeout', detail: '' })).toBe('transient');
    expect(classifyProbeCause({ kind: 'exit', exitCode: 1, detail: '' })).toBe('deterministic');
    expect(classifyProbeCause({ kind: 'unparseable', detail: '' })).toBe('deterministic');
    expect(classifyProbeCause({ kind: 'opaque', detail: '' })).toBe('deterministic');
  });
});

describe('failureOfError', () => {
  it('reads a killed command as a timeout, an errno-coded error by its code, and anything else as opaque', () => {
    expect(failureOfError(Object.assign(new Error('x'), { killed: true }))).toMatchObject({ cause: 'transient', evidence: { kind: 'timeout' } });
    expect(failureOfError(errno('EMFILE'))).toMatchObject({ cause: 'transient', evidence: { kind: 'errno', code: 'EMFILE' } });
    expect(failureOfError('boom')).toMatchObject({ cause: 'deterministic', evidence: { kind: 'opaque', detail: 'boom' } });
  });
});

describe('valueOrThrow and isTransientFailure', () => {
  it('returns values, substitutes only for gone, and throws a typed error for a failure', () => {
    expect(valueOrThrow('listing', { kind: 'value', value: [1] }, [])).toEqual([1]);
    expect(valueOrThrow('listing', { kind: 'gone' }, [])).toEqual([]);
    const failure = probeFailed({ kind: 'errno', code: 'EMFILE', detail: 'too many' });
    expect(() => valueOrThrow('listing', failure, [])).toThrow(ProbeFailedError);
    expect(() => valueOrThrow('listing', failure, [])).toThrow('listing failed (transient): too many');
  });

  it('is transient for transient probe failures and transient errno, and for nothing else', () => {
    expect(isTransientFailure(new ProbeFailedError('x', probeFailed({ kind: 'timeout', detail: '' })))).toBe(true);
    expect(isTransientFailure(new ProbeFailedError('x', probeFailed({ kind: 'exit', exitCode: 2, detail: '' })))).toBe(false);
    expect(isTransientFailure(errno('EMFILE'))).toBe(true);
    expect(isTransientFailure(errno('EACCES'))).toBe(false);
    expect(isTransientFailure(new Error('plain'))).toBe(false);
  });
});

describe('judgeProcessIdentity', () => {
  it('judges the same start time as the same process', () => {
    expect(judgeProcessIdentity(1000, { kind: 'value', value: 1000 })).toEqual({ kind: 'same' });
  });

  it('judges a different start time, or a start time where none was recorded, as a replaced process', () => {
    expect(judgeProcessIdentity(1000, { kind: 'value', value: 2000 })).toEqual({ kind: 'replaced' });
    expect(judgeProcessIdentity(undefined, { kind: 'value', value: 2000 })).toEqual({ kind: 'replaced' });
  });

  it('judges a pid with no process as gone', () => {
    expect(judgeProcessIdentity(1000, { kind: 'gone' })).toEqual({ kind: 'gone' });
  });

  it('never turns a failed probe into a verdict about the process', () => {
    const failure = probeFailed({ kind: 'timeout', detail: 'ps timed out' });
    expect(judgeProcessIdentity(1000, failure)).toBe(failure);
  });
});
