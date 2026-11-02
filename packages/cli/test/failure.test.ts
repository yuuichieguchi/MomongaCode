import { describe, expect, it } from 'vitest';
import { describeFailure } from '../src/failure.ts';

class Remediable extends Error {
  readonly detail = 'license not accepted';
  readonly remediation = 'sudo fm license';
}

describe('describeFailure', () => {
  it('prints the message of a plain error', () => {
    expect(describeFailure(new Error('boom'))).toBe('boom');
  });

  it('adds the detail and the remedy of an error that carries them', () => {
    expect(describeFailure(new Remediable('fm preconditions are not satisfied'))).toBe('fm preconditions are not satisfied\n  detail: license not accepted\n  remedy: sudo fm license');
  });

  it('prints a thrown non-error value as text', () => {
    expect(describeFailure('plain')).toBe('plain');
  });
});
