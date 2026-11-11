import type { Clock } from './clock.ts';
import { uuidv7 } from './uuidv7.ts';

export const CALL_ID_PREFIX = 'call_';

export const newCallId = (clock: Clock): string => `${CALL_ID_PREFIX}${uuidv7(clock).replaceAll('-', '')}`;
