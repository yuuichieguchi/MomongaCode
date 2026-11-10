import { MODEL_ID_CHANGED_CODE } from '@momonga/protocol';
import { invalidRequest } from '../core/errors.ts';
import type { GatewayError } from '../core/errors.ts';

const MODEL_ID_CHANGED_STATUS = 412;

export const modelIdChangedError = (display: string, listed: string, entry: string): GatewayError =>
  invalidRequest(MODEL_ID_CHANGED_CODE, `The server of ${display} lists "${listed}", not "${entry}". Run /models add to add the model it serves now.`, 'model', MODEL_ID_CHANGED_STATUS);
