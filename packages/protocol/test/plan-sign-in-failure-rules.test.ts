import { describe, expect, it } from 'vitest';
import * as protocol from '@momonga/protocol';

type Rule = { status: number; type: string; template: string };

const rules = (): Readonly<Record<string, Rule>> => (protocol as unknown as { PLAN_SIGN_IN_FAILURE_RULES: Readonly<Record<string, Rule>> }).PLAN_SIGN_IN_FAILURE_RULES;

describe('the sign-in failures are one table of code, status, type and template (P5b, G6)', () => {
  it('holds exactly the rows of the design table', () => {
    expect(rules()).toEqual({
      attempt_not_found: { status: 404, type: 'not_found', template: 'This sign-in attempt is no longer open.' },
      attempt_expired: { status: 400, type: 'invalid_request', template: 'This sign-in attempt expired before the browser returned.' },
      state_mismatch: { status: 400, type: 'invalid_request', template: 'The sign-in response did not belong to this attempt and was ignored.' },
      access_denied: { status: 400, type: 'invalid_request', template: 'Sign-in was cancelled in the browser.' },
      authorization_failed: { status: 400, type: 'invalid_request', template: '{identityLabel} refused the sign-in ({error}).' },
      registration_incomplete: { status: 400, type: 'invalid_request', template: '{identityLabel} did not return an app registration, so nothing was saved.' },
      client_mismatch: {
        status: 400,
        type: 'invalid_request',
        template: '{identityLabel} returned a different app registration than the one saved for this account. The saved account was left unchanged.',
      },
      registration_superseded: {
        status: 409,
        type: 'invalid_request',
        template: 'Another sign-in for this account finished first. An app registered during this attempt remains listed in {identityLabel} settings; you can remove it there.',
      },
      exchange_rejected: { status: 400, type: 'invalid_request', template: '{identityLabel} rejected the sign-in code ({error}).' },
      exchange_unavailable: { status: 502, type: 'server_error', template: '{identityLabel} could not be reached to finish the sign-in.' },
      token_response_invalid: { status: 502, type: 'server_error', template: '{identityLabel} returned a sign-in response this version cannot use ({reason}). Nothing was saved.' },
      id_token_invalid: { status: 400, type: 'invalid_request', template: 'The identity returned by {identityLabel} could not be verified ({check}). Nothing was saved.' },
      jwks_unavailable: { status: 502, type: 'server_error', template: 'The keys needed to verify the identity returned by {identityLabel} could not be fetched.' },
      identity_mismatch: { status: 400, type: 'invalid_request', template: 'The account that signed in is not the account saved under this label. Nothing was changed.' },
      identity_not_exchanged: { status: 409, type: 'invalid_request', template: 'This sign-in attempt has no account identity to confirm yet: the browser has not returned.' },
      identity_late: { status: 409, type: 'invalid_request', template: 'The identity returned by {identityLabel} arrived after this sign-in attempt had ended. Nothing was saved.' },
    });
    expect([...protocol.PLAN_SIGN_IN_FAILURES].sort()).toEqual(Object.keys(rules()).sort());
  });
});
