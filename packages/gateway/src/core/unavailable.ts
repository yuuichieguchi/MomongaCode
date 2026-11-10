import type { Unavailable } from '@momonga/protocol';
import { GatewayError } from './errors.ts';

export const unavailableError = (unavailable: Unavailable): GatewayError =>
  new GatewayError({ status: unavailable.status, type: unavailable.type, code: unavailable.code, message: unavailable.message, param: unavailable.param ?? null });
