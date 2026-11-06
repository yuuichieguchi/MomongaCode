export type AuthorizationFailure = 'required' | 'denied' | 'timed_out' | 'invalid_callback';

export class OAuthAuthorizationError extends Error {
  readonly failure: AuthorizationFailure;

  constructor(failure: AuthorizationFailure, message: string) {
    super(message);
    this.name = 'OAuthAuthorizationError';
    this.failure = failure;
  }
}
