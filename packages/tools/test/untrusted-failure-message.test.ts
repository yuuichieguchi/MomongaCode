import { describe, expect, it } from 'vitest';
import { recordValidateFailure, untrustedSchemaFailure } from '../src/untrusted-schema.ts';

describe('the message of a recorded validator failure', () => {
  it('is stripped of control characters and terminal escapes and capped before any notice carries it', () => {
    const schema = { type: 'object', title: 'failure-message-sanitizing' };
    recordValidateFailure('server-a\u0000tool', schema, `bad\u0000\u001b[31m red\u001b[0m\u0007 ${'x'.repeat(5000)}`);
    const message = untrustedSchemaFailure('server-a\u0000tool', schema);
    expect(message).toBeDefined();
    expect(message).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(message).toContain('bad red');
    expect(message?.length).toBeLessThanOrEqual(200);
  });

  it('is not shared with another identity that sends the identical schema', () => {
    const schema = { type: 'object', title: 'failure-identity' };
    recordValidateFailure('server-a\u0000tool', schema, 'boom');
    expect(untrustedSchemaFailure('server-b\u0000tool', schema)).toBeUndefined();
  });
});
