import { describe, expect, it } from 'vitest';
import { recordUntrustedSchemaFailure, takeUntrustedSchemaFailureNotice, untrustedSchemaFailure } from '../src/untrusted-schema.ts';

describe('the message of a recorded validator failure', () => {
  it('is stripped of control characters and terminal escapes and capped before any notice carries it', () => {
    const schema = { type: 'object', title: 'failure-message-sanitizing' };
    recordUntrustedSchemaFailure(schema, `bad\u0000\u001b[31m red\u001b[0m\u0007 ${'x'.repeat(5000)}`);
    const message = takeUntrustedSchemaFailureNotice(schema);
    expect(message).toBeDefined();
    expect(message).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(message).toContain('bad red');
    expect(message?.length).toBeLessThanOrEqual(200);
    expect(untrustedSchemaFailure(schema)).toBe(message);
  });
});
