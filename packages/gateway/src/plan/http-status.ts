import { SERVICE_UNAVAILABLE_STATUS } from '@momonga/protocol';

export const SUCCESS_STATUS = 200;
export const INVALID_REQUEST_STATUS = 400;
export const CONFLICT_STATUS = 409;
export const TOO_MANY_REQUESTS_STATUS = 429;
export const SERVER_ERROR_FLOOR = 500;
export const RETRYABLE_STATUS = SERVICE_UNAVAILABLE_STATUS;

export const answeredLater = (status: number): boolean => status === TOO_MANY_REQUESTS_STATUS || status >= SERVER_ERROR_FLOOR;
