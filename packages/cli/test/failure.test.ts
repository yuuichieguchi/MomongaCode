import { describe, expect, it } from 'vitest';
import { RunApiError } from '../src/client/runtime-client.ts';
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

  it('states mode_unavailable plainly, without the request that was refused', () => {
    const body = JSON.stringify({ error: { type: 'invalid_request_error', code: 'mode_unavailable', message: 'auto mode needs a classifier model alias: set autoMode.classifier in the user settings' } });
    const refused = new RunApiError('POST /v1/sessions', 409, body);

    expect(describeFailure(refused)).toBe('permission mode unavailable: auto mode needs a classifier model alias: set autoMode.classifier in the user settings');
  });

  it('prints a thrown non-error value as text', () => {
    expect(describeFailure('plain')).toBe('plain');
  });
});
