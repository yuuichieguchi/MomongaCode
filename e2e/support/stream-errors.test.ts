import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { trackStreamErrors } from './stream-errors.ts';

describe('trackStreamErrors', () => {
  it('stays silent while the stream is healthy', () => {
    expect(() => trackStreamErrors(new PassThrough(), 'the pipe').assertHealthy()).not.toThrow();
  });

  it('keeps an error of the stream and reports it when asked, instead of dropping it', () => {
    const stream = new PassThrough();
    const tracked = trackStreamErrors(stream, 'the pipe');

    stream.emit('error', new Error('EPIPE'));

    expect(() => tracked.assertHealthy()).toThrow('the pipe failed');
    expect(() => tracked.assertHealthy()).toThrow(expect.objectContaining({ errors: [expect.objectContaining({ message: 'EPIPE' })] }));
  });
});
