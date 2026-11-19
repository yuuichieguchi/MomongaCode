import { SESSION_ID_HEADER } from '@momonga/protocol';
import { invalidRequest } from './errors.ts';

const SESSION_ID_SHAPE = /^[A-Za-z0-9._:-]{1,128}$/;

export const sessionIdOfHeader = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const sessionId = value.trim();
  if (!SESSION_ID_SHAPE.test(sessionId)) {
    throw invalidRequest('invalid_session_id', `the ${SESSION_ID_HEADER} header must be 1 to 128 letters, digits or the characters . _ : -`, SESSION_ID_HEADER);
  }
  return sessionId;
};
