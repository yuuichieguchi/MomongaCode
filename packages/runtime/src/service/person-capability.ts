import { timingSafeEqual } from 'node:crypto';
import { PERSON_CAPABILITY_HEADER } from '@momonga/protocol';
import { personOnly } from './errors.ts';

export const requirePersonCapability = (request: Request, expected: string): void => {
  const presented = Buffer.from(request.headers.get(PERSON_CAPABILITY_HEADER) ?? '', 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  if (presented.length !== wanted.length || !timingSafeEqual(presented, wanted)) throw personOnly();
};
