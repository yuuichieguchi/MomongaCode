import { MODEL_ID_CHANGED_CODE, messageOf } from '@momonga/protocol';
import { invalidRequest } from '../core/errors.ts';
import type { GatewayError } from '../core/errors.ts';

const MODEL_ID_CHANGED_STATUS = 412;

export const modelIdChangedError = (named: { server: string; model: string }, listed: string, entry: string): GatewayError =>
  invalidRequest(MODEL_ID_CHANGED_CODE, messageOf('modelIdChanged', 'gateway', { ...named, listed, entry }), 'model', MODEL_ID_CHANGED_STATUS);
